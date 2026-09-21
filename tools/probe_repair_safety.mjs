#!/usr/bin/env node
/** Probe: find an input whose OCR repair has more than one valid reading. */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../gstin-core.js');

const seeds = [
  '27AAPFU0939F1ZV', '29AAICP2912R1ZR', '07AAACR5055K1Z9', '24AAACT2727Q1Z2',
  '09AABCU9603R1ZL', '36AABCT1332L1ZF', '28AAPFU0939F1ZT'
];
const TO_LETTER = { '0': 'O', '1': 'I', '2': 'Z', '5': 'S', '6': 'G', '8': 'B', '7': 'T', '4': 'A' };
const TO_DIGIT = { O: '0', Q: '0', D: '0', U: '0', I: '1', L: '1', Z: '2', A: '4', S: '5', G: '6', T: '7', B: '8', P: '9' };

let hits = 0;
for (const seed of seeds) {
  for (let i = 0; i < 14; i++) {
    const ch = seed[i];
    let sub = null;
    if (/[0-9]/.test(ch) && TO_LETTER[ch]) sub = TO_LETTER[ch];
    else if (/[A-Z]/.test(ch) && TO_DIGIT[ch]) sub = 'X';  // letters -> digit handled below
    if (sub === 'X' || sub === null) continue;
    const mangled = seed.slice(0, i) + sub + seed.slice(i + 1);
    if (mangled === seed) continue;
    const r = C.repairChecksum(mangled);
    if (r.solutions.length >= 1 && !r.skipped) {
      console.log(`seed=${seed} pos=${i} '${ch}'->'${sub}' input=${mangled} solutions=${r.solutions.length} best=${r.best} dist=${r.bestDistance} ambiguous=${r.ambiguous}`);
      hits++;
    }
  }
}
console.log('total probed hits:', hits);
