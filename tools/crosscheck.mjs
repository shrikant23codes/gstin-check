#!/usr/bin/env node
/**
 * Cross-check: compute check digits with gstin-core.js and print the resulting
 * GSTINs for an independent verifier (tools/verify_gstin.py, backed by
 * python-stdnum) to confirm.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../gstin-core.js');

const HEADS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      '27AAPFU0939F1Z',
      '29AAICP2912R1Z',
      '28AAPFU0939F1Z',
      '07AAACR5055K1Z',
      '24AAACT2727Q1Z',
      '09AABCU9603R1Z',
      '19AAACI2456P1Z',
      '33AAACR5055K1Z',
      '36AABCT1332L1Z',
      '01AAAAA0000A1Z',
      '38AAACL1234B1Z'
    ];

const out = [];
for (const head of HEADS) {
  const d = C.checkDigit(head);
  if (d === null) {
    console.error('bad head:', head);
    process.exit(1);
  }
  const full = head + d;
  out.push(full);
  console.error(`${head} + ${d} = ${full}  selfcheck=${C.checksumOk(full)}`);
}
process.stdout.write(out.join(' ') + '\n');
