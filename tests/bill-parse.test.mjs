#!/usr/bin/env node
/**
 * Tests for bill-parse.js — run with:  node --test tests/bill-parse.test.mjs
 * Fixtures mirror the layouts Indian retail bills actually print.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const B = require('../bill-parse.js');

// A plain 5% restaurant bill: 641.90 taxable + 16.05 + 16.05 = 674.00. The name
// and address are fictional, like every fixture in this repo.
const DHABA = `
HIGHWAY DHABA
Main Road, Maharashtra
GSTIN : 27AAPFU0939F1ZV
TAX INVOICE
------------------------------------------
Masala Dosa           2        240.00
Dal Fry               1        180.00
Tea                   3        150.00
Rotli                 4         71.90
------------------------------------------
Taxable Value                  641.90
CGST @2.5%                      16.05
SGST @2.5%                      16.05
------------------------------------------
Grand Total                    674.00
`;

test('reads the dhaba bill: taxable, both tax halves and the total', () => {
  const b = B.parseBill(DHABA);
  assert.equal(b.taxableValue, 641.9);
  assert.equal(b.components.cgst, 16.05);
  assert.equal(b.components.sgst, 16.05);
  assert.equal(b.taxAmount, 32.1);
  assert.equal(b.total, 674);
  assert.equal(b.taxCharged, true);
  assert.equal(b.rate, 5);
  assert.equal(b.halved, true);
  assert.equal(b.invoiceKind, 'tax-invoice');
  assert.ok(b.confidence === 'high');
});

test('each figure carries the line it was read from', () => {
  const b = B.parseBill(DHABA);
  const cgst = b.evidence.find((e) => e.field === 'cgst');
  assert.ok(cgst);
  assert.match(cgst.line, /CGST/);
  assert.equal(cgst.value, 16.05);
  const total = b.evidence.find((e) => e.field === 'total');
  assert.match(total.line, /GRAND TOTAL/);   // evidence lines are upper-cased
});

test('a tax rate is never mistaken for a tax amount', () => {
  const b = B.parseBill('CGST 2.5% 16.05\nSGST 2.5% 16.05\nTotal 674.00');
  assert.equal(b.components.cgst, 16.05);
  assert.equal(b.components.sgst, 16.05);
  assert.equal(b.taxAmount, 32.1);
});

test('both components on one line are split correctly, not double counted', () => {
  const b = B.parseBill('Taxable Value   641.90\nCGST 2.5% 16.05   SGST 2.5% 16.05\nTotal 674.00');
  assert.equal(b.components.cgst, 16.05);
  assert.equal(b.components.sgst, 16.05);
  assert.equal(b.taxAmount, 32.1);
});

test('amounts printed left of the label are picked up', () => {
  const b = B.parseBill('641.90   TAXABLE VALUE\n16.05    CGST @ 2.5%\n16.05    SGST @ 2.5%\n674.00   GRAND TOTAL');
  assert.equal(b.taxableValue, 641.9);
  assert.equal(b.components.cgst, 16.05);
  assert.equal(b.total, 674);
});

test('an interstate IGST bill is read as one component', () => {
  const b = B.parseBill('Taxable Value   1000.00\nIGST @18%         180.00\nGrand Total     1180.00');
  assert.equal(b.components.igst, 180);
  assert.equal(b.components.cgst, 0);
  assert.equal(b.taxAmount, 180);
  assert.equal(b.rate, 18);
  assert.equal(b.halved, false);
});

test('unlabelled tax is derived from total minus taxable', () => {
  const b = B.parseBill('Taxable Value  1000.00\nGrand Total    1180.00');
  assert.equal(b.taxAmount, 180);
  assert.equal(b.taxCharged, true);
  assert.ok(b.derived.includes('tax = total - taxable'));
});

test('a bill with no tax at all is not reported as charging GST', () => {
  const b = B.parseBill('Coffee 1  80.00\nSandwich 1  120.00\nTotal  200.00');
  assert.equal(b.taxCharged, false);
  assert.equal(b.taxAmount, 0);
});

test('a composition dealer bill of supply is recognised', () => {
  const b = B.parseBill([
    'BILL OF SUPPLY',
    'COMPOSITION TAXABLE PERSON, NOT ELIGIBLE TO COLLECT TAX ON SUPPLIES',
    'GSTIN : 27AAPFU0939F1ZV',
    'Total  450.00'
  ].join('\n'));
  assert.equal(b.invoiceKind, 'bill-of-supply');
  assert.equal(b.taxCharged, false);
});

test('comma grouping and currency prefixes are handled', () => {
  const b = B.parseBill('Taxable Value  Rs. 1,234.56\nCGST @9%  Rs. 111.11\nSGST @9%  Rs. 111.11\nGrand Total  Rs. 1,456.78');
  assert.equal(b.taxableValue, 1234.56);
  assert.equal(b.components.cgst, 111.11);
  assert.equal(b.total, 1456.78);
});

test('the total is taken from the label, not from cash tendered', () => {
  const b = B.parseBill('Total 674.00\nCash 700.00\nChange 26.00');
  assert.equal(b.total, 674);
});

test('the last total line wins when a bill prints a summary', () => {
  const b = B.parseBill('Sub Total 641.90\nTaxable Value 641.90\nCGST 16.05\nSGST 16.05\nInvoice Total 674.00');
  assert.equal(b.total, 674);
  assert.equal(b.taxableValue, 641.9);
});

test('taxable is derived when only a total is printed', () => {
  const b = B.parseBill('CGST 16.05\nSGST 16.05\nGrand Total 674.00');
  assert.equal(b.taxAmount, 32.1);
  assert.equal(b.taxableValue, 641.9);
  assert.ok(b.derived.includes('taxable = total - tax'));
});

test('an unusable bill yields low confidence rather than invented numbers', () => {
  const b = B.parseBill('||| ... blurry soup ###');
  assert.equal(b.confidence, 'low');
  assert.equal(b.total, null);
  assert.equal(b.taxableValue, null);
  assert.equal(b.taxCharged, false);
  assert.equal(b.evidence.length, 0);
});

test('moneyTokens skips rates but keeps amounts', () => {
  const t = B.moneyTokens('CGST @ 2.5%  16.05  ₹674.00');
  assert.deepEqual(t.map((x) => x.value), [16.05, 674]);
});
