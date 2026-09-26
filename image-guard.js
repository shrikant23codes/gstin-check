/*!
 * image-guard.js — decide whether an uploaded photo is safe to decode.
 *
 * Pure: no DOM, no network. Takes the first chunk of a file as a byte array and
 * answers three questions before anything expensive happens:
 *
 *   1. Is it a format we can actually read?      -> sniff()  (magic bytes)
 *   2. Is the compressed file small enough?      -> check()  (MAX_BYTES)
 *   3. How many pixels will it decode to?        -> check()  (MAX_PIXELS)
 *
 * Question 3 is the one that matters. A PNG of a solid colour can be a few
 * hundred KB on disk and still decode to gigabytes of RGBA — a decompression
 * bomb. File size alone cannot catch that, so the dimensions are read straight
 * out of the file header, before any decoder is handed the data.
 *
 * If a header cannot be parsed the file is still allowed through (the byte cap
 * applies); the caller re-checks the decoded bitmap. Refusing a real bill
 * because a header was unusual is the worse failure for this app.
 *
 * Works as a browser global (window.ImageGuard) and as a CommonJS module.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ImageGuard = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_BYTES = 15 * 1024 * 1024;       // 15 MB — a bill photo is normally 2–5 MB
  var MAX_PIXELS = 40 * 1000 * 1000;      // 40 MP — far above any phone camera, below a bomb
  var MAX_EDGE = 1800;                    // what Tesseract wants; also the decode target
  var HEAD_BYTES = 256 * 1024;            // enough for a JPEG SOF or a HEIC meta box

  var LABELS = { jpeg: 'JPEG', png: 'PNG', webp: 'WebP', heic: 'HEIC/HEIF' };

  // ISO-BMFF brands that mean "still image, possibly HEIC" — what an iPhone
  // writes by default. Safari decodes these; Chrome and Firefox generally do not.
  var HEIF_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs',
                     'mif1', 'msf1', 'heif'];

  // --------------------------------------------------------------------- bytes
  function u16be(b, o) { return (b[o] << 8) | b[o + 1]; }
  function u16le(b, o) { return b[o] | (b[o + 1] << 8); }
  function u24le(b, o) { return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16); }
  function u32be(b, o) {
    return ((b[o] * 0x1000000) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]));
  }
  function u32le(b, o) {
    return ((b[o]) | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] * 0x1000000));
  }
  function fourcc(b, o) {
    return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  }

  // ---------------------------------------------------------------------- sniff
  /** Identify the image format from its first bytes. Returns a kind or null. */
  function sniff(head) {
    if (!head || head.length < 12) return null;
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'png';
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
    if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
        head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return 'webp';
    if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) {
      var brand = fourcc(head, 8);
      if (HEIF_BRANDS.indexOf(brand) !== -1) return 'heic';
    }
    return null;
  }

  // ------------------------------------------------------------- size readers
  function pngSize(b) {
    if (b.length < 24) return null;
    // 8-byte signature, 4 length, 'IHDR', then width and height (big-endian).
    return { width: u32be(b, 16), height: u32be(b, 20) };
  }

  // Start-of-frame markers carry the real dimensions; the rest are metadata.
  var SOF = { 0xc0: 1, 0xc1: 1, 0xc2: 1, 0xc3: 1, 0xc5: 1, 0xc6: 1, 0xc7: 1,
              0xc9: 1, 0xca: 1, 0xcb: 1, 0xcd: 1, 0xce: 1, 0xcf: 1 };

  function jpegSize(b) {
    var p = 2;                                   // skip SOI
    while (p + 9 <= b.length) {
      if (b[p] !== 0xff) { p++; continue; }
      var m = b[p + 1];
      if (m === 0xff || m === 0x00) { p++; continue; }        // fill / stuffed byte
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd9)) { p += 2; continue; }  // no payload
      var len = u16be(b, p + 2);
      if (len < 2) return null;
      if (SOF[m]) return { height: u16be(b, p + 5), width: u16be(b, p + 7) };
      p += 2 + len;
    }
    return null;
  }

  function webpSize(b) {
    if (b.length < 30) return null;
    var type = fourcc(b, 12);
    if (type === 'VP8X') {                        // extended: canvas size - 1, 24-bit LE
      return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    }
    if (type === 'VP8L') {                        // lossless: 14-bit fields, packed
      var bits = u32le(b, 21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
    if (type === 'VP8 ') {                        // lossy: after the 3-byte sync code
      return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    }
    return null;
  }

  /**
   * HEIC/HEIF dimensions. Metadata is an ISO-BMFF box tree:
   *   meta > iprp > ipco > ispe   (ispe is a FullBox: 4 bytes, then w and h as u32)
   * Validated against a real sips-generated .heic.
   */
  function heicSize(b) {
    var pos = 0;
    while (pos + 8 <= b.length) {
      var size = u32be(b, pos);
      var type = fourcc(b, pos + 4);
      if (size === 0) return null;                 // "rest of file" — not a size we can step
      if (size < 8) return null;
      if (type === 'meta') return digForIspe(b, pos + 12, pos + size, ['iprp', 'ipco']);
      pos += size;
    }
    return null;
  }

  /** Walk nested boxes until `ispe`, then read width/height from it. */
  function digForIspe(b, start, end, path) {
    var p = start;
    while (p + 8 <= end && p + 8 <= b.length) {
      var size = u32be(b, p);
      var type = fourcc(b, p + 4);
      if (size < 8) return null;
      if (path.length && type === path[0]) {
        return digForIspe(b, p + 8, p + size, path.slice(1));
      }
      if (!path.length && type === 'ispe' && p + 20 <= b.length) {
        return { width: u32be(b, p + 12), height: u32be(b, p + 16) };
      }
      p += size;
    }
    return null;
  }

  function readSize(head, kind) {
    try {
      if (kind === 'png') return pngSize(head);
      if (kind === 'jpeg') return jpegSize(head);
      if (kind === 'webp') return webpSize(head);
      if (kind === 'heic') return heicSize(head);
    } catch (e) { /* a malformed header is not a reason to reject */ }
    return null;
  }

  // ---------------------------------------------------------------------- check
  function mb(n) { return (n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB'; }

  /**
   * Validate a candidate upload before decoding.
   *
   * @param {number} byteLength   file.size
   * @param {ArrayLike<number>} head  first chunk of the file (>= 12 bytes; ideally HEAD_BYTES)
   * @returns {{ok:boolean, kind:?string, width:?number, height:?number, reason:?string}}
   */
  function check(byteLength, head) {
    if (!byteLength) {
      return { ok: false, kind: null, width: null, height: null,
               reason: 'That file is empty. Pick a photo of the bill.' };
    }
    var kind = sniff(head);
    if (!kind) {
      return { ok: false, kind: null, width: null, height: null,
               reason: 'That does not look like a JPEG, PNG, WebP or iPhone (HEIC) photo. ' +
                       'Pick the original photo again.' };
    }
    if (byteLength > MAX_BYTES) {
      return { ok: false, kind: kind, width: null, height: null,
               reason: 'That image is ' + mb(byteLength) + ', over the ' + mb(MAX_BYTES) +
                       ' limit. A bill photo is normally 2–5 MB — please pick a smaller one.' };
    }
    var size = readSize(head, kind);
    if (size && size.width > 0 && size.height > 0) {
      var px = size.width * size.height;
      if (px > MAX_PIXELS) {
        return { ok: false, kind: kind, width: size.width, height: size.height,
                 reason: 'That image is ' + size.width + '×' + size.height + ' (' +
                         Math.round(px / 1e6) + ' megapixels), over the ' +
                         Math.round(MAX_PIXELS / 1e6) + ' MP limit. A smaller photo is plenty — ' +
                         'the bill only needs to be legible.' };
      }
      return { ok: true, kind: kind, width: size.width, height: size.height };
    }
    // Dimensions unknown but the byte cap passed: allow, caller re-checks after decode.
    return { ok: true, kind: kind, width: null, height: null };
  }

  /**
   * Target decode size for createImageBitmap — aspect-correct, longest edge MAX_EDGE.
   * Returns {} when dimensions are unknown, letting the browser preserve the ratio.
   */
  function decodeTarget(width, height) {
    if (!width || !height) return {};
    var scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    return {
      resizeWidth: Math.max(1, Math.round(width * scale)),
      resizeHeight: Math.max(1, Math.round(height * scale))
    };
  }

  return {
    MAX_BYTES: MAX_BYTES,
    MAX_PIXELS: MAX_PIXELS,
    MAX_EDGE: MAX_EDGE,
    HEAD_BYTES: HEAD_BYTES,
    LABELS: LABELS,
    sniff: sniff,
    readSize: readSize,
    check: check,
    decodeTarget: decodeTarget
  };
}));
