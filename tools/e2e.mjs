#!/usr/bin/env node
/**
 * End-to-end test: drives the real app in a real headless Chrome over the
 * DevTools Protocol, with no npm dependencies (Node's global fetch + WebSocket).
 *
 *   node tools/e2e.mjs [--url http://localhost:8788/] [--headed]
 *
 * What it actually exercises:
 *   - the page boots with no console errors and all four modules loaded
 *   - the typed-GSTIN path renders a verdict
 *   - a bill photo fed into the real file input goes through OCR, extraction,
 *     bill parsing and the verdict engine, and comes out the other side
 *   - the service worker registers
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const getFlag = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const APP_URL = getFlag('url', 'http://localhost:8788/');
const HEADED = argv.includes('--headed');
const DEBUG_PORT = Number(getFlag('port', '9333'));
const SHOT_DIR = getFlag('shot', null);

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
];

// ---------------------------------------------------------------- assertions
const results = [];
let current = null;
function section(name) { current = name; }
function check(label, ok, detail) {
  results.push({ section: current, label, ok: !!ok, detail: detail === undefined ? null : detail });
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok || detail === undefined ? '' : '  -> ' + JSON.stringify(detail)));
}

// ------------------------------------------------------------- CDP plumbing
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.console = []; this.errors = []; }
  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws error')); });
    const cdp = new CDP(ws);
    ws.addEventListener('message', (ev) => cdp._onMessage(JSON.parse(ev.data)));
    return cdp;
  }
  _onMessage(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      this.console.push({ type: msg.params.type, text });
      if (msg.params.type === 'error') this.errors.push(text);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      this.errors.push(d.exception?.description || d.text || 'exception');
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      this.errors.push(msg.params.entry.text + (msg.params.entry.url ? ' @ ' + msg.params.entry.url : ''));
    }
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout: ' + method)); }
      }, 60000);
    });
  }
  /** Evaluate an expression, awaiting a promise result. */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }
  async waitFor(expression, { timeout = 120000, interval = 500, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try { last = await this.eval(expression); if (last) return last; }
      catch (e) { last = 'eval error: ' + e.message; }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error('timed out waiting for ' + label + ' (last: ' + JSON.stringify(last) + ')');
  }
}

async function launchChrome() {
  const bin = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!bin) throw new Error('no Chrome/Chromium found; tried:\n' + CHROME_CANDIDATES.join('\n'));
  const profile = mkdtempSync(path.join(tmpdir(), 'gstin-e2e-'));
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + DEBUG_PORT, '--user-data-dir=' + profile,
    '--allow-insecure-localhost', '--disable-features=Translate',
    'about:blank'
  ];
  if (HEADED) args.splice(0, 1, '--new-window');
  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', () => {});

  const deadline = Date.now() + 30000;
  let wsUrl = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      const j = await res.json();
      if (j.webSocketDebuggerUrl) { wsUrl = j.webSocketDebuggerUrl; break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!wsUrl) { proc.kill('SIGKILL'); throw new Error('Chrome devtools endpoint never came up'); }
  return { proc, wsUrl, bin, profile };
}

// ------------------------------------------------------------------- helpers
async function newPageTarget(browser) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const list = await browser.send('Target.getTargets');
  const target = list.targetInfos.find((t) => t.targetId === targetId);
  const attached = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  return { targetId, sessionId: attached.sessionId, target };
}

/** Drive a session-scoped CDP connection through the browser connection. */
function session(browser, sessionId) {
  const s = Object.create(browser);
  // Flattened protocol: sessionId rides along on every call.
  s.send = (method, params = {}) => {
    const id = ++browser.id;
    return new Promise((resolve, reject) => {
      browser.pending.set(id, { resolve, reject });
      browser.ws.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => { if (browser.pending.has(id)) { browser.pending.delete(id); reject(new Error('timeout: ' + method)); } }, 60000);
    });
  };
  s.eval = async (expression) => {
    const r = await s.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  s.waitFor = async (expression, opts = {}) => {
    const { timeout = 120000, interval = 500, label = expression } = opts;
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try { last = await s.eval(expression); if (last) return last; } catch (e) { last = 'eval error: ' + e.message; }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error('timed out waiting for ' + label + ' (last: ' + JSON.stringify(last) + ')');
  };
  return s;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Save a device-scale screenshot of the current page, when --shot is given. */
async function shoot(p, name) {
  if (!SHOT_DIR) return;
  const { data } = await p.send('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, name + '.png');
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log('  shot  ' + file);
}

// ---------------------------------------------------------------------- main
let chrome;
try {
  chrome = await launchChrome();
  console.log('chrome:', chrome.bin, '\napp:   ', APP_URL, '\n');

  const browser = await CDP.attach(chrome.wsUrl);
  const page = await newPageTarget(browser);
  const p = session(browser, page.sessionId);

  await p.send('Runtime.enable');
  await p.send('Page.enable');
  await p.send('DOM.enable');
  await p.send('Log.enable');
  p.console = browser.console;
  p.errors = browser.errors;

  // Render as a phone, which is how this app is actually used at a counter.
  await p.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true
  });
  await p.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

  // ---------------------------------------------------------- 1. it boots
  section('boot');
  await p.send('Page.navigate', { url: APP_URL });
  await p.waitFor("document.readyState === 'complete'", { label: 'page load' });
  await sleep(2500);

  const boot = await p.eval(`(() => ({
    title: document.title,
    libs: {
      GstinCore: typeof window.GstinCore,
      BillParse: typeof window.BillParse,
      ImagePrep: typeof window.ImagePrep,
      Tesseract: typeof window.Tesseract
    },
    checkDigit: window.GstinCore && window.GstinCore.checkDigit('27AAPFU0939F1Z'),
    state: window.GstinCore && window.GstinCore.decode('27AAPFU0939F1ZV').stateName,
    captureVisible: !document.getElementById('capturePanel').hidden,
    resultHidden: document.getElementById('result').hidden,
    cameraBtn: !!document.getElementById('cameraBtn'),
    manifest: !!document.querySelector('link[rel=manifest]')
  }))()`);
  check('four modules loaded in the page', Object.values(boot.libs).every((v) => v === 'object' || v === 'function' || v !== 'undefined'),
    boot.libs);
  check('Tesseract loaded from the CDN', boot.libs.Tesseract === 'object', boot.libs.Tesseract);
  check('check digit agrees inside the browser', boot.checkDigit === 'V', boot.checkDigit);
  check('GSTIN decodes inside the browser', boot.state === 'Maharashtra', boot.state);
  check('capture panel is the initial state', boot.captureVisible && boot.resultHidden);
  check('manifest is linked', boot.manifest);

  const sw = await p.eval(`navigator.serviceWorker.getRegistration().then(r => !!r)`);
  check('service worker registered', sw);
  await shoot(p, '01-idle-light');

  // ------------------------------------------------- 2. typed GSTIN -> verdict
  section('typed GSTIN');
  await p.eval(`(() => {
    const el = document.getElementById('gstinInput');
    el.value = '27AAPFU0939F1ZV';
    el.dispatchEvent(new Event('input', {bubbles:true}));
    return true;
  })()`);
  const hint = await p.eval(`document.getElementById('typeHint').textContent`);
  check('live hint confirms a valid number', /Valid number/.test(hint), hint);

  await p.eval(`(() => {
    const el = document.getElementById('gstinInput');
    el.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
    return true;
  })()`);
  await p.waitFor(`!document.getElementById('result').hidden`, { label: 'result panel' });

  const typed = await p.eval(`(() => ({
    gstin: document.getElementById('gstinText').textContent,
    chip: document.getElementById('confidenceChip').textContent,
    level: document.getElementById('verdictCard').getAttribute('data-level'),
    headline: document.getElementById('verdictHeadline').textContent,
    facts: Array.from(document.querySelectorAll('#facts dt')).map(e => e.textContent)
  }))()`);
  check('shows the grouped number', typed.gstin === '27 AAPFU 0939 F 1 Z V', typed.gstin);
  check('unverified verdict makes no legal claim', typed.level === 'unknown', typed.level);
  check('the verdict says status is unverified', /not yet verified/i.test(typed.headline), typed.headline);
  check('decoded facts rendered', typed.facts.includes('State') && typed.facts.includes('Registered as'), typed.facts);

  // a bill charging GST, still unverified, must not claim it is illegal
  await p.eval(`(() => {
    const c = document.getElementById('taxCharged');
    c.checked = true; c.dispatchEvent(new Event('change', {bubbles:true}));
    const t = document.getElementById('taxableValue'); t.value = '641.90';
    t.dispatchEvent(new Event('input', {bubbles:true}));
    const a = document.getElementById('taxAmount'); a.value = '32.10';
    a.dispatchEvent(new Event('input', {bubbles:true}));
    return true;
  })()`);
  const rate = await p.eval(`({
    note: document.getElementById('rateNote').textContent,
    hidden: document.getElementById('rateNote').hidden,
    level: document.getElementById('verdictCard').getAttribute('data-level')
  })`);
  check('implied rate computed from the figures', /5%/.test(rate.note), rate.note);
  check('unverified + taxed stays unverified, not illegal', rate.level === 'unknown', rate.level);

  // ------------------------------------------------ 4. OCR from a real photo
  section('OCR from a photographed bill');
  await p.eval(`(() => { document.getElementById('result').hidden = true; return true; })()`);

  const billPath = path.join(ROOT, 'sample-bills', 'dhaba-photo.jpg');
  if (!existsSync(billPath)) throw new Error('missing sample bill: ' + billPath);

  const doc = await p.send('DOM.getDocument', { depth: -1 });
  const node = await p.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#photoInput' });
  if (!node.nodeId) throw new Error('#photoInput not found in the DOM');
  await p.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [billPath] });
  await p.eval(`document.getElementById('photoInput').dispatchEvent(new Event('change', {bubbles:true}))`);

  const ocrResult = await p.waitFor(
    `(() => {
       const r = document.getElementById('result');
       if (!r.hidden) return { done: 'result' };
       const t = document.querySelector('.js-transient h2');
       if (t) return { done: 'notfound', text: t.textContent };
       return false;
     })()`,
    { label: 'OCR to finish', timeout: 300000, interval: 1500 }
  );
  check('OCR produced a result panel', ocrResult.done === 'result', ocrResult);

  const scanned = await p.eval(`(() => ({
    gstin: document.getElementById('gstinText').textContent,
    chip: document.getElementById('confidenceChip').textContent,
    taxCharged: document.getElementById('taxCharged').checked,
    taxable: document.getElementById('taxableValue').value,
    tax: document.getElementById('taxAmount').value,
    evidence: Array.from(document.querySelectorAll('#evidenceTable tr')).map(r =>
      Array.from(r.children).map(c => c.textContent)),
    ocrHead: (document.getElementById('ocrText').textContent||'').slice(0, 200)
  }))()`);
  check('GSTIN read from the photo', scanned.gstin.replace(/\s/g, '') === '27AAPFU0939F1ZV', scanned.gstin);
  // Ties the committed image to its generator: a stale fixture, or someone
  // swapping in a real business name, fails here.
  check('image carries the fictional fixture name', /HIGHWAY DHABA/i.test(scanned.ocrHead),
    scanned.ocrHead.slice(0, 48));
  check('reads tax as charged', scanned.taxCharged === true);
  check('reads the taxable value 641.90', Math.abs(parseFloat(scanned.taxable) - 641.9) < 0.01, scanned.taxable);
  check('reads the tax amount 32.10', Math.abs(parseFloat(scanned.tax) - 32.1) < 0.01, scanned.tax);
  check('shows which line each figure came from', scanned.evidence.length >= 3, scanned.evidence.length);

  // ------------------------------- 5. the composition bill photo end to end
  section('OCR of a composition dealer bill');
  const compPath = path.join(ROOT, 'sample-bills', 'composition-photo.jpg');
  const node2 = await p.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#photoInput' });
  await p.send('DOM.setFileInputFiles', { nodeId: node2.nodeId, files: [compPath] });
  await p.eval(`document.getElementById('photoInput').dispatchEvent(new Event('change', {bubbles:true}))`);

  const comp = await p.waitFor(
    `(() => { const r = document.getElementById('result');
              return r.hidden ? false : { gstin: document.getElementById('gstinText').textContent,
                                         chip: document.getElementById('confidenceChip').textContent }; })()`,
    { label: 'composition bill OCR', timeout: 300000, interval: 1500 }
  );
  check('GSTIN read off the composition bill', comp.gstin.replace(/\s/g, '') === '08AAACR5055K1Z7', comp);

  // invoiceKind should be recognised as a bill of supply from the printed words
  const kind = await p.eval(`window.BillParse.parseBill(document.getElementById('ocrText').textContent).invoiceKind`);
  check('recognises the bill-of-supply wording', kind === 'bill-of-supply', kind);
  await shoot(p, '04-composition-scanned');

  // ---------------------------------------- 6. no node accumulation on rescan
  section('repeated scans do not accumulate nodes');
  const before = await p.eval(`(() => ({
    legend: document.querySelectorAll('#factsLegend').length,
    legendText: document.querySelectorAll('#factsLegend').length &&
                document.getElementById('factsLegend').textContent.length,
    transient: document.querySelectorAll('.js-transient').length,
    facts: document.querySelectorAll('#facts dt').length,
    evidence: document.querySelectorAll('#evidenceTable tr').length
  }))()`);

  // Re-check the same number several times, and re-render the verdict each time.
  for (let i = 0; i < 4; i++) {
    await p.eval(`(() => {
      const el = document.getElementById('gstinInput');
      el.value = '27AAPFU0939F1ZV';
      el.dispatchEvent(new Event('input', {bubbles:true}));
      el.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
      const c = document.getElementById('taxCharged');
      c.checked = true; c.dispatchEvent(new Event('change', {bubbles:true}));
      const a = document.getElementById('taxAmount'); a.value = '10';
      a.dispatchEvent(new Event('input', {bubbles:true}));
      return true;
    })()`);
    await sleep(150);
  }
  const after = await p.eval(`(() => ({
    legend: document.querySelectorAll('#factsLegend').length,
    legendText: document.querySelectorAll('#factsLegend').length &&
                document.getElementById('factsLegend').textContent.length,
    transient: document.querySelectorAll('.js-transient').length,
    facts: document.querySelectorAll('#facts dt').length,
    evidence: document.querySelectorAll('#evidenceTable tr').length
  }))()`);

  check('exactly one legend node exists', after.legend === 1, { before: before.legend, after: after.legend });
  check('legend text did not duplicate', after.legendText === before.legendText,
    { before: before.legendText, after: after.legendText });
  check('fact rows stay at six', after.facts === 6, after.facts);
  check('evidence table does not grow', after.evidence <= before.evidence + 1,
    { before: before.evidence, after: after.evidence });
  check('no stale transient panels pile up', after.transient <= 1, after.transient);

  await shoot(p, '05-rescan');

  // ------------------------------------------------ 7. no console errors at all
  section('console hygiene');
  const realErrors = browser.errors.filter((e) => !/favicon|DevTools/i.test(e));
  check('no uncaught page errors', realErrors.length === 0, realErrors.slice(0, 6));

  // ------------------------------------------------------------------ report
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(64));
  console.log(`e2e: ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFAILED:');
    failed.forEach((f) => console.log('  [' + f.section + '] ' + f.label + (f.detail ? '  -> ' + JSON.stringify(f.detail) : '')));
  }
  process.exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.error('\ne2e harness error:', err.message);
  process.exitCode = 2;
} finally {
  if (chrome) {
    chrome.proc.kill('SIGKILL');
    try { rmSync(chrome.profile, { recursive: true, force: true }); } catch {}
  }
}
