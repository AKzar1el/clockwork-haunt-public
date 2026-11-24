import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const project = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(project, 'dist');
const chrome = [
  process.env.CHROME_BIN,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].find(path => path && existsSync(path));
if (!chrome) throw new Error('Set CHROME_BIN to a local Chromium browser executable.');

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const server = createServer(async (req, res) => {
  try {
    const name = new URL(req.url, 'http://127.0.0.1').pathname;
    const file = resolve(output, '.' + (name === '/' ? '/index.html' : name));
    if (!file.startsWith(output + sep) || !types[extname(file)]) throw new Error('Not found');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)], 'Cache-Control': 'no-store' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((ready, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', ready);
});
const root = resolve(project, 'test-results');
await mkdir(root, { recursive: true });
const scratch = await mkdtemp(resolve(root, 'clockwork-browser-'));
const child = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--disable-background-networking',
  '--no-first-run', '--no-default-browser-check', '--disable-sync',
  '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
  '--user-data-dir=' + resolve(scratch, 'profile'), 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
let launchError;
child.on('error', err => { launchError = err; });
child.stderr.on('data', data => { stderr += data; });
let ws;
try {
  const activePort = resolve(scratch, 'profile', 'DevToolsActivePort');
  let port;
  for (let i = 0; i < 100 && !port && !launchError && child.exitCode === null; i++) {
    try { port = Number((await readFile(activePort, 'utf8')).split('\n')[0]); }
    catch { await delay(100); }
  }
  if (!port) throw launchError ?? new Error('Chrome did not start: ' + stderr.slice(-1200));
  const tabs = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const tab = tabs.find(t => t.type === 'page');
  assert(tab?.webSocketDebuggerUrl, 'Local browser test tab');
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((ready, reject) => {
    ws.addEventListener('open', ready, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const pending = new Map();
  const errors = [];
  let id = 0;
  ws.addEventListener('message', ({ data }) => {
    const m = JSON.parse(data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
    const item = pending.get(m.id);
    if (!item) return;
    pending.delete(m.id);
    clearTimeout(item.timer);
    if (m.error) item.reject(new Error(m.error.message));
    else item.result(m.result);
  });
  const call = (method, params = {}) => new Promise((result, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('Browser command timed out: ' + method));
    }, 5000);
    pending.set(requestId, { result, reject, timer });
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async (expression) => {
    const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  };
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/' });
  for (let i = 0; i < 70 && !(await evaluate("!!document.querySelector('#report .facts')")); i++) await delay(70);
  const text = () => evaluate("document.querySelector('#report').innerText");
  const choose = async (selector, value) => evaluate(
    '(() => { const el = document.querySelector(' + JSON.stringify(selector) + '); el.value = ' +
    JSON.stringify(value) + '; el.dispatchEvent(new Event("change", {bubbles: true})); })()',
  );
  const has = async (...patterns) => {
    const current = await text();
    for (const pattern of patterns) assert.match(current, pattern);
  };
  await has(/CH-02/, /Run status\s+Success/, /Input freshness\s+Stale/, /planned producer: collector-w1/);
  await choose('#scenario', 'fresh');
  await has(/CH-01/, /Input freshness\s+Fresh/, /Age at Read\s+2 min/, /08:08/);
  await choose('#scenario', 'wait');
  await has(/CH-03a/, /Input freshness\s+Fresh/, /Wait started\s+08:06/, /Finished\s+08:14/);
  await choose('#variant', '1');
  await has(/CH-03b/, /ArtifactNeverPublished/);
  await choose('#variant', '2');
  await has(/CH-03c/, /CompletionWouldExceedCutoff/);
  await choose('#scenario', 'duplicate');
  await has(/CH-04/, /Attempts\s+2\s+Effects\s+1/, /Suppressed.*duplicates/);
  await choose('#variant', '1');
  await has(/Attempts\s+2\s+Effects\s+2/);
  assert.doesNotMatch(await text(), /Suppressed/);
  const downloads = resolve(scratch, 'downloads');
  await mkdir(downloads);
  await call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await evaluate("document.querySelector('#export').click()");
  const before = await text();
  await evaluate("document.querySelector('#replay').click()");
  assert.equal(await text(), before);
  const filename = await evaluate("document.querySelector('#announcer').textContent.split(':')[0].replace('Replayed ', '')") + '-evidence.json';
  assert.equal(basename(filename), filename);
  let payload;
  for (let i = 0; i < 60 && !payload; i++) {
    try { payload = await readFile(resolve(downloads, filename), 'utf8'); }
    catch { await delay(100); }
  }
  const evidence = JSON.parse(payload);
  assert.equal(evidence.slots.find(s => s.attemptCount === 2).effectCount, 2);
  assert(Array.isArray(evidence.eventLog));
  assert.equal(Object.hasOwn(evidence, 'timestamp'), false);
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'No horizontal page overflow at 390px');
  assert.deepEqual(errors, []);
  console.log('PASS Chrome: CH-01 through CH-04, both deadline misses, dedupe toggle, replay, JSON download, 390px layout');
} finally {
  ws?.close();
  server.close();
  if (child.exitCode === null) child.kill();
  if (resolve(scratch).startsWith(root + sep) && basename(scratch).startsWith('clockwork-browser-')) {
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(() => {});
  }
}
