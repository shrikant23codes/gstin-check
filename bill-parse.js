/*!
 * bill-parse.js — read the money off an OCR'd GST bill.
 *
 * Pure functions, no DOM/network. Tolerant of the shapes Indian retail bills
 * actually print: "CGST@2.5% 32.10", "SGST 2.5 %  32.10", "Grand Total : 674.00",
 * amounts printed left of the label, comma grouping, and ₹ / Rs. / INR prefixes.
 *
 * Every number comes back with the line it was read from, because a confidently
 * wrong total is worse than an admitted guess — the UI shows the evidence and
 * lets the user correct it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BillParse = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LABELS = {
    taxable: [
      /TAXABLE\s*(?:VALUE|AMOUNT)?/, /SUB\s*-?\s*TOTAL/, /NET\s*(?:AMOUNT|VALUE)/,
      /BASIC\s*(?:AMOUNT|VALUE|PRICE)/, /AMOUNT\s*BEFORE\s*TAX/, /VALUE\s*OF\s*SUPPLY/,
      /TOTAL\s*VALUE/, /GROSS\s*(?:AMOUNT|VALUE)/
    ],
    total: [
      /GRAND\s*TOTAL/, /INVOICE\s*TOTAL/, /BILL\s*(?:TOTAL|AMOUNT)/, /NET\s*PAYABLE/,
      /AMOUNT\s*PAYABLE/, /TOTAL\s*AMOUNT/, /\bTOTAL\b/
    ],
    cgst: [/C\.?GST/, /CENTRAL\s*TAX/],
    sgst: [/S\.?GST/, /STATE\s*TAX/, /UTGST/, /UNION\s*TERRITORY\s*TAX/],
    igst: [/I\.?GST/, /INTEGRATED\s*TAX/]
  };

  var TAX_INVOICE_RE = /TAX\s*INVOICE|TAX\s*BILL|TAX\s*INV/;
  var BILL_OF_SUPPLY_RE = /BILL\s*OF\s*SUPPLY|COMPOSITION\s*TAXABLE\s*PERSON|NOT\s*ELIGIBLE\s*TO\s*COLLECT/;

  /** Numbers on a line, skipping anything immediately followed by '%'. */
  function moneyTokens(line) {
    var out = [], re = /(\d[\d,]*(?:\.\d+)?)\s*(%)?/g, m;
    while ((m = re.exec(line)) !== null) {
      if (m[2] === '%') continue;                       // a rate, not an amount
      var n = parseFloat(m[1].replace(/,/g, ''));
      if (isFinite(n)) out.push({ value: n, start: m.index, end: m.index + m[0].length });
    }
    return out;
  }

  /**
   * Amount for a label on one line: the first number after the label, falling
   * back to the nearest number before it (many bills print value-then-label).
   *
   * Using "first after the label" is also what makes a single line carrying both
   * components — "CGST 2.5% 16.05  SGST 2.5% 16.05" — resolve correctly for each
   * label instead of being counted twice.
   */
  function amountForLabel(line, patterns) {
    for (var p = 0; p < patterns.length; p++) {
      var m = patterns[p].exec(line);
      if (!m) continue;
      var tokens = moneyTokens(line);
      if (!tokens.length) continue;
      var after = tokens.filter(function (t) { return t.start >= m.index + m[0].length; });
      if (after.length) return { value: after[0].value, label: m[0].trim(), line: line.trim() };
      var before = tokens.filter(function (t) { return t.end <= m.index; });
      if (before.length) return { value: before[before.length - 1].value, label: m[0].trim(), line: line.trim() };
    }
    return null;
  }

  function parseBill(text) {
    var raw = String(text == null ? '' : text);
    var lines = raw.split(/\r?\n/).map(function (l) { return l.toUpperCase(); });
    var evidence = [];

    function pickAll(patterns) {
      var hits = [];
      for (var i = 0; i < lines.length; i++) {
        var hit = amountForLabel(lines[i], patterns);
        if (hit) hits.push(hit);
      }
      return hits;
    }

    function sum(hits, field) {
      var total = 0;
      hits.forEach(function (h) {
        total += h.value;
        evidence.push({ field: field, value: h.value, line: h.line, label: h.label });
      });
      return total;
    }

    // --- tax components -----------------------------------------------------
    var cgstHits = pickAll(LABELS.cgst);
    var sgstHits = pickAll(LABELS.sgst);
    var igstHits = pickAll(LABELS.igst);

    var cgst = sum(cgstHits, 'cgst');
    var sgst = sum(sgstHits, 'sgst');
    var igst = sum(igstHits, 'igst');
    var taxAmount = +(cgst + sgst + igst).toFixed(2);
    var taxLines = cgstHits.length + sgstHits.length + igstHits.length;

    // --- totals -------------------------------------------------------------
    var totalHits = pickAll(LABELS.total);
    var total = totalHits.length ? totalHits[totalHits.length - 1].value : null;
    if (totalHits.length) {
      var t = totalHits[totalHits.length - 1];
      evidence.push({ field: 'total', value: t.value, line: t.line, label: t.label });
    }

    var taxableHits = pickAll(LABELS.taxable);
    var taxableValue = taxableHits.length ? taxableHits[0].value : null;
    if (taxableHits.length) {
      var tv = taxableHits[0];
      evidence.push({ field: 'taxable', value: tv.value, line: tv.line, label: tv.label });
    }

    // --- reconcile ----------------------------------------------------------
    var derived = [];
    if (taxAmount === 0 && taxableValue != null && total != null && total - taxableValue > 0.5) {
      taxAmount = +(total - taxableValue).toFixed(2);
      taxLines = Math.max(taxLines, 1);
      derived.push('tax = total - taxable');
    }
    if (taxableValue == null && total != null) {
      taxableValue = +(total - taxAmount).toFixed(2);
      derived.push(taxAmount > 0 ? 'taxable = total - tax' : 'taxable = total');
    }

    var taxCharged = taxAmount > 0.5;

    var rate = null;
    if (taxableValue > 0 && taxAmount > 0) rate = +(taxAmount / taxableValue * 100).toFixed(2);

    var invoiceKind = BILL_OF_SUPPLY_RE.test(raw) ? 'bill-of-supply'
      : (TAX_INVOICE_RE.test(raw) ? 'tax-invoice' : 'unknown');

    var confidence = 'low';
    if (taxLines >= 2 && total != null && taxableValue != null) confidence = 'high';
    else if (total != null && (taxLines >= 1 || taxableValue != null)) confidence = 'medium';

    return {
      taxCharged: taxCharged,
      taxAmount: taxAmount || 0,
      taxableValue: taxableValue,
      total: total,
      rate: rate,
      components: {
        cgst: cgst, cgstLines: cgstHits.length,
        sgst: sgst, sgstLines: sgstHits.length,
        igst: igst, igstLines: igstHits.length
      },
      // Restaurant bills normally split the rate evenly across CGST and SGST.
      halved: cgstHits.length > 0 && sgstHits.length > 0 && Math.abs(cgst - sgst) < 0.02,
      invoiceKind: invoiceKind,
      confidence: confidence,
      derived: derived,
      evidence: evidence
    };
  }

  return { parseBill: parseBill, moneyTokens: moneyTokens, amountForLabel: amountForLabel };
}));
