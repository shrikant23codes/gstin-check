#!/usr/bin/env node
/** Tests for image-guard.js — run with:  node --test tests/image-guard.test.mjs */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const G = require('../image-guard.js');

const fixture = (rel) => fileURLToPath(new URL('../' + rel, import.meta.url));

/** First `n` bytes of a file, exactly as the browser would slice it. */
function head(path, n = G.HEAD_BYTES) {
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(n);
  const read = readSync(fd, buf, 0, n, 0);
  closeSync(fd);
  return buf.subarray(0, read);
}

// ------------------------------------------------------------------- sniffing
test('sniff identifies a real PNG', () => {
  assert.equal(G.sniff(head(fixture('sample-bills/composition-clean.png'))), 'png');
});

test('sniff identifies a real JPEG', () => {
  assert.equal(G.sniff(head(fixture('sample-bills/dhaba-photo.jpg'))), 'jpeg');
});

test('sniff identifies a real HEIC written by the OS', () => {
  assert.equal(G.sniff(head(fixture('tests/fixtures/tiny.heic'))), 'heic');
});

test('sniff identifies WebP only when both RIFF and WEBP are present', () => {
  const good = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8X')]);
  assert.equal(G.sniff(good), 'webp');
  const riffOnly = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI LIST')]);
  assert.equal(G.sniff(riffOnly), null);
});

test('sniff rejects non-images and short input', () => {
  assert.equal(G.sniff(Buffer.from('<html><body>hi')), null);
  assert.equal(G.sniff(Buffer.from([0xff, 0xd8, 0xff])), null, 'too short to be sure');
  assert.equal(G.sniff(new Uint8Array(0)), null);
});

// ------------------------------------------------------------------ dimensions
test('pngSize reads the real fixture exactly', () => {
  const s = G.readSize(head(fixture('sample-bills/composition-clean.png')), 'png');
  assert.deepEqual(s, { width: 760, height: 698 });
});

test('jpegSize finds the SOF past EXIF-ish metadata', () => {
  const s = G.readSize(head(fixture('sample-bills/dhaba-photo.jpg')), 'jpeg');
  assert.deepEqual(s, { width: 786, height: 935 });
});

test('heicSize walks meta > iprp > ipco > ispe', () => {
  // The container's ispe can be a row larger than the decoded image (chroma
  // padding); for a size cap the container figure is the safe one to use.
  const s = G.readSize(head(fixture('tests/fixtures/tiny.heic')), 'heic');
  assert.equal(s.width, 32);
  assert.ok(s.height >= 29 && s.height <= 30, 'height ~29-30, got ' + s.height);
});

/** Build a minimal WebP header for a given variant. */
function webp(variant, w, h) {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0); b.writeUInt32LE(22, 4); b.write('WEBP', 8); b.write(variant, 12);
  b.writeUInt32LE(10, 16);
  if (variant === 'VP8X') {
    b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
  } else if (variant === 'VP8L') {
    b[20] = 0x2f;
    b.writeUInt32LE((w - 1) | ((h - 1) << 14), 21);
  } else if (variant === 'VP8 ') {
    b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a;
    b.writeUInt16LE(w, 26); b.writeUInt16LE(h, 28);
  }
  return b;
}

test('webpSize handles all three WebP variants', () => {
  for (const variant of ['VP8X', 'VP8L', 'VP8 ']) {
    assert.deepEqual(G.readSize(webp(variant, 800, 600), 'webp'),
                     { width: 800, height: 600 }, variant);
  }
});

test('readSize returns null rather than throwing on a broken header', () => {
  assert.equal(G.readSize(Buffer.alloc(10), 'jpeg'), null);
  assert.equal(G.readSize(Buffer.from([0x89, 0x50]), 'png'), null);
});

// ---------------------------------------------------------------------- check
test('an empty file is refused', () => {
  const r = G.check(0, Buffer.alloc(0));
  assert.equal(r.ok, false);
  assert.match(r.reason, /empty/i);
});

test('a non-image is refused by name', () => {
  const r = G.check(500, Buffer.from('<html>hello there</html>'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /JPEG, PNG, WebP|does not look like/);
});

test('a file over the byte cap is refused, and says how large it is', () => {
  const png = head(fixture('sample-bills/composition-clean.png'));
  const r = G.check(G.MAX_BYTES + 1, png);
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'png');
  assert.match(r.reason, /15 MB/);
});

test('a decompression bomb is caught by pixel count, not file size', () => {
  // A PNG header claiming 20000x20000, but only 1 KB on disk. File-size limits
  // alone would wave this through; it would decode to ~1.6 GB of RGBA.
  const bomb = Buffer.alloc(64);
  bomb[0] = 0x89; bomb[1] = 0x50; bomb[2] = 0x4e; bomb[3] = 0x47;
  bomb.write('IHDR', 12);
  bomb.writeUInt32BE(20000, 16);
  bomb.writeUInt32BE(20000, 20);
  const r = G.check(1024, bomb);
  assert.equal(r.ok, false);
  assert.match(r.reason, /400 megapixels/);
});

test('a normal phone photo passes and reports its size', () => {
  const png = head(fixture('sample-bills/composition-clean.png'));
  const r = G.check(statSync(fixture('sample-bills/composition-clean.png')).size, png);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'png');
  assert.deepEqual([r.width, r.height], [760, 698]);
  assert.equal(r.reason, undefined);
});

test('unknown dimensions pass the byte check but are flagged as unknown', () => {
  // A truncated JPEG: valid magic, no SOF within the head. Must not be rejected
  // outright — the caller re-checks the decoded bitmap.
  const r = G.check(5000, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]));
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'jpeg');
  assert.equal(r.width, null);
});

// --------------------------------------------------------------- decode target
test('decodeTarget scales the longest edge to MAX_EDGE, preserving aspect', () => {
  assert.deepEqual(G.decodeTarget(4000, 3000), { resizeWidth: 1800, resizeHeight: 1350 });
  assert.deepEqual(G.decodeTarget(3000, 4000), { resizeWidth: 1350, resizeHeight: 1800 });
});

test('decodeTarget leaves small images alone', () => {
  assert.deepEqual(G.decodeTarget(760, 698), { resizeWidth: 760, resizeHeight: 698 });
});

test('decodeTarget yields no constraint when dimensions are unknown', () => {
  assert.deepEqual(G.decodeTarget(null, null), {});
  assert.deepEqual(G.decodeTarget(0, 0), {});
});
