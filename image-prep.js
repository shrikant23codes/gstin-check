/*!
 * image-prep.js — the pixel maths that makes a phone photo of a bill readable.
 *
 * Kept separate from the canvas plumbing (and free of DOM references) so it can
 * be unit-tested in plain Node. Input is a flat RGBA byte array, exactly like
 * ImageData.data.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ImagePrep = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Luminance of an RGBA pixel.
   *
   * Uses Math.round, not `| 0`: the weighted sum for a mid grey lands on
   * 127.99999999999999 in binary floating point, and truncating that silently
   * shifts an entire tone band down by one level.
   */
  function luminance(r, g, b) {
    return Math.round(r * 0.299 + g * 0.587 + b * 0.114);
  }

  /** Luminance histogram of an RGBA buffer. */
  function histogram(px) {
    var hist = new Array(256).fill(0);
    for (var i = 0; i < px.length; i += 4) {
      hist[luminance(px[i], px[i + 1], px[i + 2])]++;
    }
    return hist;
  }

  /** Grey everything in place. */
  function toGreyscale(px) {
    for (var i = 0; i < px.length; i += 4) {
      var g = luminance(px[i], px[i + 1], px[i + 2]);
      px[i] = px[i + 1] = px[i + 2] = g;
    }
    return px;
  }

  /**
   * Otsu's threshold: the split that maximises between-class variance.
   * Returns 0..255. A bimodal histogram (ink on paper) gives the valley.
   */
  function otsu(hist, total) {
    if (!total) return 127;
    var sum = 0, t;
    for (t = 0; t < 256; t++) sum += t * hist[t];
    var sumB = 0, wB = 0, best = 127, bestVar = -1;
    for (t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      var wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      var mB = sumB / wB, mF = (sum - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);
      if (between > bestVar) { bestVar = between; best = t; }
    }
    return best;
  }

  /**
   * Contrast stretch around the 2nd and 98th luminance percentiles, so a few
   * blown highlights or a shadow do not flatten the whole image.
   */
  function percentileBounds(hist, total, lowerPct, upperPct) {
    var loCut = total * lowerPct, hiCut = total * upperPct, acc = 0, lo = 0, hi = 255, t;
    for (t = 0; t < 256; t++) { acc += hist[t]; if (acc >= loCut) { lo = t; break; } }
    acc = 0;
    for (t = 255; t >= 0; t--) { acc += hist[t]; if (acc >= hiCut) { hi = t; break; } }
    if (hi - lo < 12) return { lo: 0, hi: 255 };   // already flat: leave it alone
    return { lo: lo, hi: hi };
  }

  /**
   * Apply one of the two enhancement passes, in place.
   *   'contrast' — greyscale + percentile stretch. Best first attempt: it keeps
   *                anti-aliased strokes that binarising would destroy.
   *   'binary'   — greyscale + Otsu threshold. Rescues faint thermal print.
   */
  function enhance(px, mode, options) {
    options = options || {};
    toGreyscale(px);
    var total = px.length / 4;
    var hist = histogram(px);

    if (mode === 'binary') {
      var t = otsu(hist, total);
      for (var i = 0; i < px.length; i += 4) {
        var v = px[i] > t ? 255 : 0;
        px[i] = px[i + 1] = px[i + 2] = v;
      }
      return { mode: mode, threshold: t, total: total };
    }

    var b = percentileBounds(hist, total, options.lowerPct || 0.02, options.upperPct || 0.02);
    var span = b.hi - b.lo;
    for (var j = 0; j < px.length; j += 4) {
      var s = (px[j] - b.lo) / span * 255;
      px[j] = px[j + 1] = px[j + 2] = s < 0 ? 0 : s > 255 ? 255 : s;
    }
    return { mode: 'contrast', lo: b.lo, hi: b.hi, total: total };
  }

  return {
    histogram: histogram,
    toGreyscale: toGreyscale,
    otsu: otsu,
    percentileBounds: percentileBounds,
    enhance: enhance
  };
}));
