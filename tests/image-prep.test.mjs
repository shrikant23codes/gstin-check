#!/usr/bin/env node
/** Tests for image-prep.js — run with:  node --test tests/image-prep.test.mjs */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../image-prep.js');

/** Build an RGBA buffer from a list of grey values (one per pixel). */
function rgba(greys) {
  const px = new Uint8ClampedArray(greys.length * 4);
  greys.forEach((g, i) => {
    px[i * 4] = g; px[i * 4 + 1] = g; px[i * 4 + 2] = g; px[i * 4 + 3] = 255;
  });
  return px;
}
const greysOf = (px) => {
  const out = [];
  for (let i = 0; i < px.length; i += 4) out.push(px[i]);
  return out;
};

test('histogram counts every pixel once', () => {
  const px = rgba([0, 0, 128, 255, 255, 255]);
  const h = P.histogram(px);
  assert.equal(h[0], 2);
  assert.equal(h[128], 1);
  assert.equal(h[255], 3);
  assert.equal(h.reduce((a, b) => a + b, 0), 6);
});

test('greyscale mixes channels by luminance, not average', () => {
  const px = new Uint8ClampedArray([0, 255, 0, 255]);   // pure green
  P.toGreyscale(px);
  assert.ok(px[0] > 140 && px[0] < 160, 'green should land near 150, got ' + px[0]);
  assert.equal(px[0], px[1]);
  assert.equal(px[1], px[2]);
});

test('otsu finds the valley of a bimodal image', () => {
  const px = rgba([...Array(400).fill(40), ...Array(600).fill(220)]);
  const t = P.otsu(P.histogram(px), 1000);
  // Otsu's between-class variance is flat across the gap, so the first maximum
  // lands on the darker mode's own value. Anything inside the gap separates the
  // two populations, which is all the caller needs.
  assert.ok(t >= 40 && t < 220, 'threshold should sit in the gap, got ' + t);
  const split = [...Array(400).fill(40), ...Array(600).fill(220)].map((g) => (g > t ? 255 : 0));
  assert.equal(split.filter((v) => v === 0).length, 400, 'the 400 ink pixels must fall below');
  assert.equal(split.filter((v) => v === 255).length, 600, 'the 600 paper pixels must fall above');
});

test('otsu survives a degenerate all-one-tone image', () => {
  const t = P.otsu(P.histogram(rgba(Array(100).fill(200))), 100);
  assert.ok(Number.isFinite(t) && t >= 0 && t <= 255, 'got ' + t);
});

test('otsu on an empty histogram does not divide by zero', () => {
  assert.equal(P.otsu(new Array(256).fill(0), 0), 127);
});

test('contrast stretch pushes low-contrast ink towards the extremes', () => {
  // A faint photo: paper at 180, ink at 140. Only 40 levels apart.
  const px = rgba([...Array(50).fill(180), ...Array(20).fill(140)]);
  const info = P.enhance(px, 'contrast');
  const g = greysOf(px);
  assert.ok(info.hi - info.lo >= 12);
  assert.ok(Math.max(...g) - Math.min(...g) > 100,
    'spread should open up a lot, got ' + (Math.max(...g) - Math.min(...g)));
});

test('a flat image is left alone rather than amplified into noise', () => {
  const px = rgba(Array(200).fill(128));
  const info = P.enhance(px, 'contrast');
  assert.deepEqual({ lo: info.lo, hi: info.hi }, { lo: 0, hi: 255 });
  assert.deepEqual([...new Set(greysOf(px))], [128]);
});

test('binary mode produces exactly two tones and keeps ink dark', () => {
  const px = rgba([...Array(60).fill(30), ...Array(120).fill(235)]);
  const info = P.enhance(px, 'binary');
  const tones = [...new Set(greysOf(px))].sort((a, b) => a - b);
  assert.deepEqual(tones, [0, 255]);
  // Inside the gap; the first Otsu maximum sits on the darker mode.
  assert.ok(info.threshold >= 30 && info.threshold < 235, 'got ' + info.threshold);
  assert.equal(info.total, 180);
  assert.equal(greysOf(px).filter((v) => v === 0).length, 60, 'the 60 ink pixels stay dark');
});

test('binary mode does not invert a light-on-dark receipt', () => {
  const px = rgba([...Array(70).fill(20), ...Array(30).fill(200)]);
  P.enhance(px, 'binary');
  const g = greysOf(px);
  const darkPixels = g.filter((v) => v === 0).length;
  assert.ok(darkPixels >= 65, 'the majority tone should be the dark one, got ' + darkPixels);
});

test('alpha is never touched', () => {
  const px = rgba([10, 200]);
  P.enhance(px, 'contrast');
  assert.equal(px[3], 255);
  assert.equal(px[7], 255);
});

test('enhance reports what it did, for the UI to trust', () => {
  const c = P.enhance(rgba([...Array(10).fill(100), ...Array(10).fill(160)]), 'contrast');
  assert.equal(c.mode, 'contrast');
  const b = P.enhance(rgba([...Array(10).fill(100), ...Array(10).fill(160)]), 'binary');
  assert.equal(b.mode, 'binary');
});
