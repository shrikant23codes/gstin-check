#!/usr/bin/env node
/*!
 * tools/build.mjs — assemble the deployable static site into dist/.
 *
 * Cloudflare Pages serves EVERY file in its output directory as a public URL, so
 * pointing it at the repo root would publish server.go, tests/, tools/, the
 * fixtures and this very script. This copies only what the app actually needs.
 *
 * It also refuses to copy .privacy-terms, even if someone passes a directory
 * that contains it — the audit terms must never reach a public URL.
 *
 * Usage:
 *   node tools/build.mjs            # write dist/
 *   node tools/build.mjs --dry-run  # list what would be copied, write nothing
 *   node tools/build.mjs --out DIR  # use a different output directory
 */
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The app shell plus the files Cloudflare Pages needs at the output root.
// `_headers` and `robots.txt` are only meaningful at the root — that is exactly
// where they end up here.
const FILES = [
  'index.html',
  'gstin-core.js',
  'bill-parse.js',
  'image-guard.js',
  'image-prep.js',
  'sw.js',
  'manifest.webmanifest',
  'robots.txt',
  '_headers',
  'LICENSE',
];

const DIRS = ['icons'];

// Never ship these, whatever else happens.
const FORBIDDEN = ['.privacy-terms', '.git', 'server.go', 'node_modules'];

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const outIdx = argv.indexOf('--out');
const OUT = outIdx !== -1 && argv[outIdx + 1]
  ? join(ROOT, argv[outIdx + 1])
  : join(ROOT, 'dist');

const show = (p) => relative(ROOT, p) || '.';
let bytes = 0;
let count = 0;

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (FORBIDDEN.includes(entry.name)) {
      throw new Error(`refusing to copy forbidden path: ${show(full)}`);
    }
    if (entry.isDirectory()) await walk(full);
    else {
      bytes += (await stat(full)).size;
      count++;
      if (dryRun) console.log('  ' + show(full));
    }
  }
}

async function copyFile(rel) {
  const src = join(ROOT, rel);
  if (!existsSync(src)) throw new Error(`missing required file: ${rel}`);
  const dest = join(OUT, rel);
  await mkdir(dirname(dest), { recursive: true });
  if (!dryRun) await cp(src, dest);
  const size = (await stat(src)).size;
  bytes += size;
  count++;
  if (dryRun) console.log('  ' + rel);
}

try {
  console.log(dryRun
    ? `dry run — would write to ${show(OUT)}/\n`
    : `building ${show(OUT)}/ …\n`);

  if (!dryRun) {
    await rm(OUT, { recursive: true, force: true });
    await mkdir(OUT, { recursive: true });
  }

  for (const f of FILES) await copyFile(f);
  for (const d of DIRS) {
    const src = join(ROOT, d);
    if (!existsSync(src)) throw new Error(`missing required directory: ${d}`);
    await walk(src);
    if (!dryRun) await cp(src, join(OUT, d), { recursive: true });
  }

  // Sanity: the two files Pages needs at the root must actually be there.
  for (const must of ['index.html', 'sw.js', '_headers']) {
    if (!FILES.includes(must)) throw new Error(`build list is missing ${must}`);
  }

  const kb = (bytes / 1024).toFixed(0);
  console.log(`\n${dryRun ? 'would copy' : 'copied'} ${count} files, ${kb} KB total`);
  if (dryRun) console.log('nothing written (--dry-run)');
} catch (err) {
  console.error('\nbuild failed: ' + err.message);
  process.exit(1);
}
