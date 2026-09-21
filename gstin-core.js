/*!
 * gstin-core.js — pure, dependency-free GSTIN logic.
 *
 *  - structural decode (state, PAN, entity type, entity number)
 *  - Luhn mod 36 check digit validate + compute   (GSTN specification)
 *  - OCR-tolerant extraction from arbitrary text (Tesseract-style confusions)
 *  - checksum repair: search single/few-char confusion substitutions
 *  - verdict engine: can this supplier legally collect GST on the bill?
 *
 * Works as a browser global (window.GstinCore) and as a CommonJS module.
 * No DOM, no network, no globals. Every function is pure.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GstinCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Reference data
  // ---------------------------------------------------------------------------

  var CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  // GST state codes. `active:false` marks codes superseded by a reorganisation
  // (25 -> 26 Daman & Diu merged; 28 -> 37 AP after Telangana bifurcation).
  var STATES = {
    '01': { name: 'Jammu and Kashmir', active: true },
    '02': { name: 'Himachal Pradesh', active: true },
    '03': { name: 'Punjab', active: true },
    '04': { name: 'Chandigarh', active: true },
    '05': { name: 'Uttarakhand', active: true },
    '06': { name: 'Haryana', active: true },
    '07': { name: 'Delhi', active: true },
    '08': { name: 'Rajasthan', active: true },
    '09': { name: 'Uttar Pradesh', active: true },
    '10': { name: 'Bihar', active: true },
    '11': { name: 'Sikkim', active: true },
    '12': { name: 'Arunachal Pradesh', active: true },
    '13': { name: 'Nagaland', active: true },
    '14': { name: 'Manipur', active: true },
    '15': { name: 'Mizoram', active: true },
    '16': { name: 'Tripura', active: true },
    '17': { name: 'Meghalaya', active: true },
    '18': { name: 'Assam', active: true },
    '19': { name: 'West Bengal', active: true },
    '20': { name: 'Jharkhand', active: true },
    '21': { name: 'Odisha', active: true },
    '22': { name: 'Chhattisgarh', active: true },
    '23': { name: 'Madhya Pradesh', active: true },
    '24': { name: 'Gujarat', active: true },
    '25': { name: 'Daman and Diu', active: false, note: 'Merged into 26 (Dadra & Nagar Haveli and Daman & Diu)' },
    '26': { name: 'Dadra and Nagar Haveli and Daman and Diu', active: true },
    '27': { name: 'Maharashtra', active: true },
    '28': { name: 'Andhra Pradesh (pre-2014)', active: false, note: 'Superseded by 37 for Andhra Pradesh' },
    '29': { name: 'Karnataka', active: true },
    '30': { name: 'Goa', active: true },
    '31': { name: 'Lakshadweep', active: true },
    '32': { name: 'Kerala', active: true },
    '33': { name: 'Tamil Nadu', active: true },
    '34': { name: 'Puducherry', active: true },
    '35': { name: 'Andaman and Nicobar Islands', active: true },
    '36': { name: 'Telangana', active: true },
    '37': { name: 'Andhra Pradesh', active: true },
    '38': { name: 'Ladakh', active: true }
  };

  // 4th character of the embedded PAN -> constitution of the registered person.
  var PAN_ENTITY = {
    A: 'Association of Persons (AOP)',
    B: 'Body of Individuals (BOI)',
    C: 'Company',
    F: 'Firm / LLP',
    G: 'Government',
    H: 'Hindu Undivided Family (HUF)',
    J: 'Artificial Juridical Person',
    L: 'Local Authority',
    P: 'Individual / Proprietor',
    T: 'Trust'
  };

  // Tesseract-grade confusions. Position class decides which way to lean.
  var TO_DIGIT = { O: '0', Q: '0', D: '0', U: '0', I: '1', L: '1', Z: '2', A: '4', S: '5', G: '6', T: '7', B: '8', P: '9' };
  var TO_LETTER = { '0': 'O', '1': 'I', '2': 'Z', '5': 'S', '6': 'G', '8': 'B', '7': 'T', '4': 'A' };

  // Position classes for the 15 characters of a GSTIN.
  //  0-1 state code (digits) | 2-6 PAN letters | 7-10 PAN digits
  //  11 PAN last letter | 12 entity number (alnum) | 13 literal 'Z' | 14 check digit
  var CLASSES = ['d', 'd', 'L', 'L', 'L', 'L', 'L', 'd', 'd', 'd', 'd', 'L', 'a', 'Z', 'a'];

  // ---------------------------------------------------------------------------
  // Verification statuses a supplier can be in, and what each means for the bill.
  // ---------------------------------------------------------------------------

  var STATUS = {
    REGULAR: 'regular',
    COMPOSITION: 'composition',
    COMPOSITION_SERVICES: 'composition_services',
    CASUAL: 'casual',
    NRTP: 'nrtp',
    ISD: 'isd',
    SEZ: 'sez',
    SUSPENDED: 'suspended',
    CANCELLED: 'cancelled',
    INVALID: 'invalid',
    UNKNOWN: 'unknown'
  };

  var STATUS_LABEL = {
    regular: 'Regular Taxpayer',
    composition: 'Composition Taxpayer',
    composition_services: 'Composition Taxpayer (services, s.10(2A))',
    casual: 'Casual Taxable Person',
    nrtp: 'Non-Resident Taxable Person',
    isd: 'Input Service Distributor',
    sez: 'SEZ Unit / Developer',
    suspended: 'Suspended',
    cancelled: 'Cancelled / Inactive',
    invalid: 'Not found / Invalid',
    unknown: 'Unverified'
  };

  // A composition dealer only ever issues a bill of supply, never a tax invoice.
  var BILL_OF_SUPPLY_RE = /bill\s*of\s*supply|composition\s*taxable\s*person|not\s*eligible\s*to\s*collect/i;
  var TAX_INVOICE_RE = /tax\s*invoice|tax\s*bill/i;

  // ---------------------------------------------------------------------------
  // Core primitives
  // ---------------------------------------------------------------------------

  /** Uppercase, drop spaces/dashes, and common OCR noise around identifiers. */
  function normalize(input) {
    if (input == null) return '';
    return String(input)
      .toUpperCase()
      .replace(/[\u2010-\u2015\u2212]/g, '-')   // unicode dashes -> ascii
      .replace(/[^A-Z0-9]/g, '');
  }

  /** char -> 0..35 as per the GSTN check-digit spec. */
  function charValue(ch) {
    var v = CHARSET.indexOf(ch);
    return v < 0 ? -1 : v;
  }

  /**
   * Luhn mod 36 checksum over an arbitrary string. Walks the string from the
   * right; positions at an even offset from the right are added as-is, odd
   * offsets are doubled and folded (divmod by 36). A complete 15-character
   * GSTIN is well-formed exactly when this is 0.
   */
  function luhnMod36(str) {
    var n = 36, total = 0;
    for (var j = 0; j < str.length; j++) {
      var v = charValue(str.charAt(str.length - 1 - j));
      if (v < 0) return -1;
      if (j % 2 === 0) {
        total += v;
      } else {
        var d = v * 2;
        total += Math.floor(d / n) + (d % n);
      }
    }
    return total % n;
  }

  /**
   * The 15th character for a 14-character GSTIN head.
   *
   * Note the parity trap: the check digit is derived from the checksum of
   * `head + "0"`, not of `head` alone. Appending the placeholder is what aligns
   * the doubling pattern with the position the check digit will occupy, and
   * getting this wrong yields a plausible-looking but systematically off-by-one
   * digit. Verified against python-stdnum's stdnum.in_.gstin.
   */
  function checkDigit(first14) {
    var head = normalize(first14).slice(0, 14);
    if (head.length !== 14) return null;
    var ck = luhnMod36(head + '0');
    if (ck < 0) return null;
    return CHARSET.charAt((36 - ck) % 36);
  }

  function checksumOk(gstin) {
    var s = normalize(gstin);
    return s.length === 15 && luhnMod36(s) === 0;
  }

  function stateOf(gstin) {
    var s = normalize(gstin);
    if (s.length !== 15) return null;
    return STATES[s.slice(0, 2)] || null;
  }

  /** Full structural + checksum decode of a candidate GSTIN. */
  function decode(input) {
    var raw = String(input == null ? '' : input);
    var s = normalize(raw);
    var issues = [];

    if (s.length !== 15) {
      issues.push({ level: 'error', code: 'length', message: 'A GSTIN is exactly 15 characters; this one is ' + s.length + '.' });
    }
    if (s.length >= 2 && !STATES[s.slice(0, 2)]) {
      issues.push({ level: 'error', code: 'state', message: 'State code "' + s.slice(0, 2) + '" is not a valid GST state code.' });
    } else if (s.length >= 2 && STATES[s.slice(0, 2)] && !STATES[s.slice(0, 2)].active) {
      issues.push({ level: 'warn', code: 'state-retired', message: 'State code "' + s.slice(0, 2) + '" is retired — ' + STATES[s.slice(0, 2)].note });
    }
    if (s.length >= 13 && s.charAt(13) !== 'Z') {
      // The spec says the 14th character is "Z" by default; a few special
      // registrations differ, so this is a flag rather than a rejection.
      issues.push({ level: 'warn', code: 'z', message: 'The 14th character is normally "Z"; this one is "' + s.charAt(13) + '".' });
    }
    for (var i = 0; i < Math.min(s.length, 15); i++) {
      var cls = CLASSES[i], ch = s.charAt(i);
      if (cls === 'd' && !/[0-9]/.test(ch)) {
        issues.push({ level: 'error', code: 'shape', message: 'Character ' + (i + 1) + ' must be a digit; found "' + ch + '".' });
      }
      if (cls === 'L' && !/[A-Z]/.test(ch)) {
        issues.push({ level: 'error', code: 'shape', message: 'Character ' + (i + 1) + ' must be a letter; found "' + ch + '".' });
      }
      if (cls === 'Z' && ch !== 'Z') {
        issues.push({ level: 'error', code: 'shape', message: 'Character 14 must be "Z"; found "' + ch + '".' });
      }
    }

    var wellFormed = issues.every(function (x) { return x.level !== 'error'; });
    var checksum = s.length === 15 ? checksumOk(s) : false;
    if (s.length === 15 && wellFormed && !checksum) {
      issues.push({
        level: 'error', code: 'checksum',
        message: 'The check digit is wrong. Expected "' + checkDigit(s) + '", found "' + s.charAt(14) + '". ' +
                 'Either a character was copied wrong, or the number on the bill is made up.'
      });
    }

    var pan = s.length >= 12 ? s.slice(2, 12) : null;
    var state = s.length >= 2 ? (STATES[s.slice(0, 2)] || null) : null;

    return {
      input: raw,
      gstin: s,
      length: s.length,
      wellFormed: wellFormed,
      checksumOk: checksum,
      valid: s.length === 15 && wellFormed && checksum,
      stateCode: s.length >= 2 ? s.slice(0, 2) : null,
      stateName: state ? state.name : null,
      stateActive: state ? !!state.active : null,
      pan: pan,
      panEntityCode: pan ? pan.charAt(3) : null,
      panEntity: pan ? (PAN_ENTITY[pan.charAt(3)] || 'Unknown (' + pan.charAt(3) + ')') : null,
      // The 5th PAN character is the first letter of the holder's surname/name.
      nameInitial: pan ? pan.charAt(4) : null,
      entityNumber: s.length >= 13 ? s.charAt(12) : null,
      checkDigitExpected: s.length >= 14 ? checkDigit(s) : null,
      formatted: format(s),
      issues: issues
    };
  }

  function format(gstin) {
    var s = normalize(gstin);
    if (s.length !== 15) return s;
    // Grouped the way it is printed on an invoice: state | PAN | entity | Z | check
    return [s.slice(0, 2), s.slice(2, 7), s.slice(7, 11), s.slice(11, 12), s.slice(12, 13), s.slice(13, 14), s.slice(14)].join(' ');
  }

  // ---------------------------------------------------------------------------
  // OCR-tolerant extraction
  // ---------------------------------------------------------------------------

  function classAllows(i, ch) {
    var cls = CLASSES[i];
    if (cls === 'd') return /[0-9]/.test(ch);
    if (cls === 'L') return /[A-Z]/.test(ch);
    if (cls === 'Z') return ch === 'Z';
    return /[A-Z0-9]/.test(ch);
  }

  /** Repair one character so it fits position i. Returns null when hopeless. */
  function repairChar(i, ch) {
    if (classAllows(i, ch)) return ch;
    var cls = CLASSES[i];
    if (cls === 'd' && TO_DIGIT[ch]) return TO_DIGIT[ch];
    if (cls === 'L' && TO_LETTER[ch]) return TO_LETTER[ch];
    if (cls === 'Z' && (ch === '2' || ch === '7')) return 'Z';
    return null;
  }

  /**
   * Every plausible reading of one 15-character window.
   *
   * Positions with a fixed class get a forced repair. The two alphanumeric
   * positions (the entity number and the check digit itself) accept either
   * case, so a letter/digit lookalike there is offered both ways — that is why
   * "…FIZV" still resolves to "…F1ZV". Returns [] when the window cannot be a
   * GSTIN at all.
   */
  function windowReadings(win) {
    var options = [], maxCost = 0;
    for (var i = 0; i < 15; i++) {
      var ch = win.charAt(i), cls = CLASSES[i], list;
      if (classAllows(i, ch)) {
        list = [ch];
        if (cls === 'a') {
          if (TO_DIGIT[ch] && TO_DIGIT[ch] !== ch && /[0-9]/.test(TO_DIGIT[ch])) list.push(TO_DIGIT[ch]);
          if (TO_LETTER[ch] && TO_LETTER[ch] !== ch && /[A-Z]/.test(TO_LETTER[ch])) list.push(TO_LETTER[ch]);
        }
      } else {
        var fixed = repairChar(i, ch);
        if (fixed === null) return [];
        list = [fixed];
      }
      if (list.length > 1) maxCost++;
      options.push(list);
    }
    if (maxCost > 5) return [];   // never explode on a garbage run

    var readings = [''], changed = [0];
    for (var k = 0; k < 15; k++) {
      var next = [], nextChanged = [];
      for (var r = 0; r < readings.length; r++) {
        for (var o = 0; o < options[k].length; o++) {
          next.push(readings[r] + options[k][o]);
          nextChanged.push(changed[r] + (options[k][o] === win.charAt(k) ? 0 : 1));
        }
      }
      readings = next; changed = nextChanged;
    }
    return readings.map(function (s, idx) { return { gstin: s, cost: changed[idx] }; });
  }

  /**
   * Pull GSTIN candidates out of free text (typically Tesseract output).
   * Returns candidates sorted best-first. Never throws.
   */
  function extract(text, options) {
    options = options || {};
    var src = String(text == null ? '' : text);
    var upper = src.toUpperCase();
    var byGstin = Object.create(null);
    var out = [];

    function push(gstin, meta) {
      var cur = byGstin[gstin];
      if (cur) {
        if (meta.score > cur.score) {
          cur.exact = meta.exact; cur.cost = meta.cost;
          cur.labelProximity = meta.labelProximity; cur.index = meta.index;
          cur.score = meta.score;
        }
        return;
      }
      var rec = {
        gstin: gstin,
        exact: !!meta.exact,
        cost: meta.cost || 0,
        index: meta.index,
        labelProximity: !!meta.labelProximity,
        checksumOk: checksumOk(gstin)
      };
      rec.score = (rec.exact ? 100 : 60) + (rec.labelProximity ? 40 : 0) + (rec.checksumOk ? 30 : 0) - rec.cost * 5;
      byGstin[gstin] = rec;
      out.push(rec);
    }

    function scan(hay) {
      // Pass 1 — the literal pattern. Catches cleanly printed bills, and also
      // records near-misses so the UI can say "this looks like a GSTIN but the
      // check digit fails".
      var strict = /\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]/g, m;
      while ((m = strict.exec(hay)) !== null) {
        push(m[0], { exact: true, cost: 0, index: m.index, labelProximity: nearLabel(hay, m.index) });
      }

      // Pass 2 — sliding 15-char windows over alphanumeric runs, repairing OCR
      // confusions positionally. A reading must survive the check digit.
      var re = /[A-Z0-9]{15,}/g, m2;
      while ((m2 = re.exec(hay)) !== null) {
        var run = m2[0], base = m2.index;
        for (var i = 0; i + 15 <= run.length; i++) {
          var win = run.substr(i, 15);
          if (!/[0-9]/.test(win)) continue;
          var readings = windowReadings(win);
          for (var r = 0; r < readings.length; r++) {
            if (!checksumOk(readings[r].gstin)) continue;
            push(readings[r].gstin, {
              exact: readings[r].cost === 0,
              cost: readings[r].cost,
              index: base + i,
              labelProximity: nearLabel(hay, base + i)
            });
          }
        }
      }
    }

    scan(upper);

    // A printed or OCR'd bill often breaks the number with spaces or dashes
    // ("27 AAPFU 0939F 1ZV"). Collapse separators that sit *between* two
    // alphanumerics and scan that view too; the check digit keeps the extra
    // permissiveness from producing false positives.
    var joined = upper.replace(/([A-Z0-9])[\s\u2010-\u2015\-.\/\\,:_|]+(?=[A-Z0-9])/g, '$1');
    if (joined !== upper) scan(joined);

    out.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    });
    return out;
  }

  /** Is there a GSTIN-ish label within ~80 chars before this offset? */
  function nearLabel(text, index) {
    var from = Math.max(0, index - 80);
    return /GSTIN|GST\s*NO|GST\s*IN|GSTN|GST\s*NUMBER|UIN/.test(text.slice(from, index + 20));
  }

  /**
   * If a candidate fails its checksum, hunt for confusion substitutions that
   * make it valid. Returns { solutions:[gstin], positions:[i], best, ambiguous }.
   * Only runs when the search space is small — we would rather say "unknown"
   * than guess a wrong GSTIN.
   */
  function repairChecksum(gstin, budget) {
    budget = budget || 200000;
    var s = normalize(gstin);
    if (s.length !== 15) return { solutions: [], positions: [], best: null, ambiguous: false, searched: 0 };
    if (checksumOk(s)) return { solutions: [s], positions: [], best: s, ambiguous: false, searched: 0 };

    var checkChar = s.charAt(14);

    var alts = [];
    for (var i = 0; i < 14; i++) {                    // the 15th is the check digit itself
      var ch = s.charAt(i), list = [ch];
      if (CLASSES[i] === 'd' && TO_DIGIT[ch]) list.push(TO_DIGIT[ch]);
      else if (CLASSES[i] === 'L' && TO_LETTER[ch]) list.push(TO_LETTER[ch]);
      alts.push(list.length > 1 ? list : [ch]);
    }
    var space = alts.reduce(function (a, l) { return a * l.length; }, 1);
    if (space > budget) return { solutions: [], positions: [], best: null, ambiguous: false, searched: space, skipped: true };

    var solutions = [], searched = 0;
    var buf = new Array(14);
    (function walk(i) {
      if (solutions.length > 40) return;
      if (i === 14) {
        searched++;
        var head = buf.join('');
        if (checkDigit(head) === checkChar) solutions.push(JSON.stringify(head + checkChar));
        return;
      }
      for (var k = 0; k < alts[i].length; k++) { buf[i] = alts[i][k]; walk(i + 1); }
    })(0);

    var uniq = [];
    solutions.forEach(function (j) {
      var g = JSON.parse(j);
      if (uniq.indexOf(g) < 0) uniq.push(g);
    });
    var diffs = uniq.map(function (g) {
      var d = 0;
      for (var i = 0; i < 14; i++) if (g.charAt(i) !== s.charAt(i)) d++;
      return d;
    });
    var best = null, bestD = 99;
    uniq.forEach(function (g, i) { if (diffs[i] < bestD) { bestD = diffs[i]; best = g; } });

    return {
      solutions: uniq,
      positions: [],
      best: best,
      bestDistance: bestD,
      ambiguous: uniq.length > 1,
      searched: searched
    };
  }

  // ---------------------------------------------------------------------------
  // Verdict engine — the actual question: may this supplier collect GST?
  // ---------------------------------------------------------------------------

  /**
   * @param {object} a
   * @param {string} a.status   one of STATUS.* (from a live lookup)
   * @param {boolean} a.verified  true when `status` came from a real lookup
   * @param {boolean} a.taxCharged  does the bill add CGST/SGST/IGST?
   * @param {number} [a.taxableValue]
   * @param {number} [a.taxAmount]
   * @param {string} [a.invoiceKind] 'tax-invoice' | 'bill-of-supply' | 'unknown'
   * @param {object} [a.decoded]
   */
  function verdict(a) {
    a = a || {};
    var status = a.status || STATUS.UNKNOWN;
    var verified = !!a.verified;
    var taxCharged = !!a.taxCharged;
    var lines = [];
    var level = 'unknown';   // ok | warn | illegal | unknown
    var headline = '';

    var CANNOT = [STATUS.COMPOSITION, STATUS.COMPOSITION_SERVICES, STATUS.SUSPENDED, STATUS.CANCELLED, STATUS.INVALID];
    var cannotCollect = CANNOT.indexOf(status) >= 0;

    if (!verified) {
      level = 'unknown';
      headline = 'Registration status not yet verified';
      lines.push('Structure and check digit are fine, but whether this supplier may legally collect GST depends on their registration status — which only a live lookup can tell you.');
      lines.push('Open the official GST portal search for this number, or add an API key in Settings to check from here.');
      if (taxCharged) lines.push('Until then: if this bill adds CGST/SGST and the supplier turns out to be a composition dealer, that tax is not payable by you.');
    } else if (cannotCollect && taxCharged) {
      level = 'illegal';
      headline = 'This GST is not collectible — refuse to pay it';
      lines.push('The supplier is registered as ' + STATUS_LABEL[status] + '. Under Section 10(4) of the CGST Act, 2017 a person paying tax under the composition scheme "shall not collect any tax from the recipient on supplies made by him".');
      lines.push('A composition dealer pays a flat rate out of their own pocket and issues a bill of supply, not a tax invoice. Tax added on top of your bill therefore does not go to the government — it stays with the seller.');
      lines.push('Rs ' + money(a.taxAmount) + ' on this bill is being collected without legal authority. You may refuse that amount, and raise a complaint on the GST portal.');
    } else if (cannotCollect && !taxCharged) {
      level = 'ok';
      headline = 'Correctly billed — no GST collected';
      lines.push('The supplier is registered as ' + STATUS_LABEL[status] + ' and has not added any tax. That is exactly how a composition dealer must bill you.');
      if (a.invoiceKind === 'tax-invoice') {
        level = 'warn';
        headline = 'Right amounts, wrong document';
        lines.push('One thing to flag: the bill calls itself a "tax invoice". A composition dealer must issue a bill of supply carrying the words "composition taxable person, not eligible to collect tax on supplies" (Rule 5, CGST Rules 2017).');
        lines.push('You cannot claim input tax credit on this purchase either way.');
      } else {
        lines.push('Note: you cannot claim input tax credit against a composition dealer\'s bill.');
      }
    } else if (taxCharged) {
      level = 'ok';
      headline = 'GST collected by a registered supplier';
      lines.push('The supplier is registered as ' + STATUS_LABEL[status] + ', so adding CGST/SGST to the invoice is lawful' +
                 (status === STATUS.REGULAR ? '.' : ' for this category of registration.'));
      lines.push('This confirms the collection is permitted. It does not prove the amount was actually remitted to the government — only the portal status does that much.');
      if (status === STATUS.SUSPENDED) lines.push('A suspended registration cannot issue a valid tax invoice and you cannot claim input tax credit on it.');
    } else {
      level = 'ok';
      headline = 'No GST on this bill';
      lines.push('The supplier is registered as ' + STATUS_LABEL[status] + ' and no tax has been added to the bill.');
    }

    // Rate sanity, independent of status. Only meaningful when both numbers exist.
    var rate = null;
    if (a.taxableValue > 0 && a.taxAmount >= 0) rate = +(a.taxAmount / a.taxableValue * 100).toFixed(2);
    var rateNote = null;
    if (rate !== null) {
      var known = [0, 0.25, 1.5, 3, 5, 6, 12, 18, 28];
      var close = known.some(function (k) { return Math.abs(k - rate) < 0.35; });
      rateNote = { rate: rate, plausible: close };
      if (!close && level === 'ok') {
        lines.push('The implied GST rate on this bill is ' + rate + '%, which is not a standard slab — worth asking about.');
      }
    }

    return {
      level: level,
      headline: headline,
      cannotCollect: cannotCollect,
      verified: verified,
      status: status,
      statusLabel: STATUS_LABEL[status],
      refundable: cannotCollect && taxCharged ? (a.taxAmount || 0) : 0,
      rate: rateNote,
      lines: lines,
      legal: cannotCollect ? [
        'Section 10(4), CGST Act 2017 — a composition taxpayer shall not collect any tax from the recipient on supplies made by him.',
        'Rule 5, CGST Rules 2017 — a composition supplier must issue a bill of supply marked "composition taxable person, not eligible to collect tax on supplies".',
        'Section 10(2A) — composition scheme for service providers at a flat rate.'
      ] : []
    };
  }

  function money(n) {
    if (n == null || isNaN(n)) return '0';
    return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  var api = {
    CHARSET: CHARSET,
    STATES: STATES,
    PAN_ENTITY: PAN_ENTITY,
    STATUS: STATUS,
    STATUS_LABEL: STATUS_LABEL,
    normalize: normalize,
    checkDigit: checkDigit,
    luhnMod36: luhnMod36,
    checksumOk: checksumOk,
    stateOf: stateOf,
    decode: decode,
    format: format,
    extract: extract,
    repairChecksum: repairChecksum,
    verdict: verdict,
    money: money
  };
  return api;
}));
