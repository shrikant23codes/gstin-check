#!/usr/bin/env node
/**
 * Bump the service worker cache version in sw.js.
 *
 *   node tools/bump_version.mjs              # v1 -> v2
 *   node tools/bump_version.mjs --set 09-21  # pin an explicit tag
 *   node tools/bump_version.mjs --check      # verify it changed since HEAD
 *
 * Why this exists: the cache name is the only lever that invalidates an
 * installed client's app shell. Forget to bump it and a released fix silently
 * never reaches anyone who already has the app installed. Making it a script
 * means it can be wired into a release step instead of remembered.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SW = path.join(ROOT, 'sw.js');

const argv = process.argv.slice(2);
const setIdx = argv.indexOf('--set');
const explicit = setIdx >= 0 ? argv[setIdx + 1] : null;
const checkOnly = argv.includes('--check');

function fail(msg) {
  console.error('bump_version: ' + msg);
  process.exit(1);
}

if (setIdx >= 0 && !explicit) fail('--set needs a value');

const src = readFileSync(SW, 'utf8');
const rx = /(var VERSION = ')([^']*)(';)/;
const m = src.match(rx);
if (!m) fail("could not find `var VERSION = '...';` in sw.js");

const current = m[2];

if (checkOnly) {
  // Compare against what is committed; useful as a pre-deploy gate.
  let committed = null;
  try {
    committed = execSync(`git show HEAD:sw.js`, {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).match(rx)?.[2] ?? null;
  } catch {
    console.log('bump_version: no git history yet, skipping check');
    process.exit(0);
  }
  if (committed === null) {
    console.log('bump_version: sw.js not in HEAD, skipping check');
    process.exit(0);
  }
  if (committed === current) {
    fail(`sw.js VERSION is unchanged (${current}) since HEAD — bump it before deploying`);
  }
  console.log(`bump_version: ok, ${committed} -> ${current}`);
  process.exit(0);
}

let next;
if (explicit) {
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(explicit)) fail('--set value must be alphanumeric, dot, dash or underscore');
  next = explicit;
} else {
  const v = /^v(\d+)$/.exec(current);
  if (!v) fail(`current version '${current}' is not of the form v<N>; pass --set to change it`);
  next = 'v' + (Number(v[1]) + 1);
}

if (next === current) fail(`version is already '${current}'`);

writeFileSync(SW, src.replace(rx, `$1${next}$3`));
console.log(`bump_version: sw.js ${current} -> ${next}`);
