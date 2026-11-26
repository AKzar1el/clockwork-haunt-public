import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createStaticServer, hasPreviewIndex } from './static-server.mjs';
import { createDebuggerClient, defaultBrowserPaths, fetchWithDeadline, readDebuggerPortAttempt, stopBrowserProcess, waitForSocketOpen } from './browser-socket.mjs';

const flags = process.argv.slice(2);
if (flags.length > 1 || flags.some(flag => flag !== '--audit')) {
  console.error('Usage: node scripts/browser-test.mjs [--audit]');
  process.exit(2);
}
const runAudit = flags[0] === '--audit';

const project = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(project, 'dist');
if (!(await hasPreviewIndex(output))) {
  console.error('No static build found. Run node build.mjs before running the browser audit.');
  process.exit(1);
}
const binary = path => Boolean(path && statSync(path, { throwIfNoEntry:false })?.isFile());
const configured = process.env.CHROME_BIN;
if (configured !== undefined && !binary(configured)) {
  console.error('CHROME_BIN must be the full path to a local Chromium browser executable.');
  process.exit(2);
}
const chrome = configured ?? defaultBrowserPaths(process.platform).find(binary);
if (!chrome) {
  console.error('No Chromium browser found. Set CHROME_BIN to its full executable path, or run node scripts/check.mjs --engine-only.');
  process.exit(2);
}

let delayAppModule = false;
let failStyleRead = false;
const pagesMount = '/clockwork-haunt-public/';
const server = createStaticServer(output, {
  mount: pagesMount,
  async beforeRead(name) {
    if (delayAppModule && name === '/ui/app.js') await delay(5200);
    if (failStyleRead && name === '/style.css') throw new Error('synthetic asset read failure');
  },
});
const root = resolve(project, 'test-results');
let scratch;
let child;
let ws;
let requestBrowserClose;
try {
  // Provision disk space before binding any socket; partial startup must
  // enter the same cleanup path as a failed browser assertion.
  await mkdir(root, { recursive: true });
  scratch = await mkdtemp(resolve(root, 'clockwork-browser-'));
  await new Promise((ready, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', ready);
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const previewUrl = origin + pagesMount;
  assert.equal((await fetchWithDeadline(origin + '/')).status,404,'The project is mounted at its Pages subpath, not the host root');
  const asset = await fetchWithDeadline(previewUrl + 'ui/app.js', { method: 'HEAD' });
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /^text\/javascript/);
  assert(asset.headers.get('content-length') > 0);
  assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await asset.text(), '');
  const fullAsset = await fetchWithDeadline(previewUrl + 'ui/app.js');
  assert.equal(fullAsset.status,200);
  assert.equal(asset.headers.get('content-length'),fullAsset.headers.get('content-length'));
  assert.equal(Number(asset.headers.get('content-length')),(await fullAsset.arrayBuffer()).byteLength);
  const icon = await fetchWithDeadline(previewUrl + 'icon.svg',{method:'HEAD'});
  assert.equal(icon.status,200);
  assert.match(icon.headers.get('content-type'),/^image\/svg\+xml/);
  const wrongMethod = await fetchWithDeadline(previewUrl, { method: 'POST' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET, HEAD');
  const missing = await fetchWithDeadline(previewUrl + 'not-present.css');
  assert.equal(missing.status,404);
  failStyleRead = true;
  const failed = await fetchWithDeadline(previewUrl + 'style.css');
  assert.equal(failed.status,500);
  assert.equal(await failed.text(),'Preview asset could not be read');
  failStyleRead = false;
  console.log('PASS preview HTTP: shared handler serves HEAD metadata and rejects unsupported methods');
  child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--disable-background-networking',
    '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--user-data-dir=' + resolve(scratch, 'profile'), 'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  let launchError;
  child.on('error', err => { launchError = err; });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
  const activePort = resolve(scratch, 'profile', 'DevToolsActivePort');
  let port;
  const startupDeadline = performance.now() + 20000;
  while (!port && !launchError && child.exitCode === null && child.signalCode === null && performance.now() < startupDeadline) {
    port = await readDebuggerPortAttempt(() => readFile(activePort, 'utf8'));
    if (!port) await delay(100);
  }
  if (!port) throw launchError ?? new Error('Chromium did not expose a debugger port within startup limits.' +
    (stderr.trim() ? ' ' + stderr.trim().slice(-1200) : ''));
  const tabs = await (await fetchWithDeadline('http://127.0.0.1:' + port + '/json/list')).json();
  const tab = tabs.find(t => t.type === 'page');
  assert(tab?.webSocketDebuggerUrl, 'Local browser test tab');
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await waitForSocketOpen(ws);
  const errors = [];
  const call = createDebuggerClient(ws, m => {
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
  }, 12000);
  requestBrowserClose = () => call('Browser.close');
  const evaluate = async (expression) => {
    const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  };
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Page.navigate', { url: previewUrl });
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
  await has(/CH-02/, /Run status\s+Success/, /Input freshness\s+Stale/);
  const staleIncident = await evaluate("document.querySelector('#report .trace').textContent");
  assert.match(staleIncident, /report-w1 requested data W1; read W0; planned producer: collector-w1; actual producer attempt: preload-w0; prior-window fallback/);
  assert.equal(await evaluate("document.querySelector('#report .columns section h2').textContent"),'report-w1');
  assert(await evaluate("[...document.querySelectorAll('[aria-label=\"Deterministic event log\"] tbody tr')].some(row=>row.cells[1].textContent==='Completion' && row.cells[2].textContent==='report-w1' && row.cells[4].textContent==='No output declared')"));
  await choose('#variant', '1');
  await has(/CH-02-no-fallback/, /Input freshness\s+Unknown/, /Unknown: publication not due yet/);
  const pendingRead = await evaluate("[...document.querySelectorAll('[aria-label=\"Inputs for report-w1\"] tbody td')].map(cell=>cell.textContent)");
  assert.equal(pendingRead[5], '08:06');
  assert.equal(pendingRead[7], 'Unknown: publication not due yet (scheduled for 08:12)');
  assert.doesNotMatch(pendingRead[4], /08:12/, 'A schedule hint must not fill the observed publication column');
  await choose('#scenario', 'fresh');
  await has(/CH-01/, /Input freshness\s+Fresh/, /Age at Read\s+2 min/, /08:08/);
  await has(/No incident trace entries/);
  await choose('#scenario', 'wait');
  const replayFact = (job, label) => evaluate(`(() => {
    const panel = [...document.querySelectorAll('#report section')]
      .find(section => section.querySelector('h2')?.textContent === ${JSON.stringify(job)});
    const fact = [...(panel?.querySelectorAll('dt') ?? [])]
      .find(dt => dt.textContent === ${JSON.stringify(label)});
    return fact?.nextElementSibling?.textContent ?? null;
  })()`);
  await has(/CH-03a/, /Input freshness\s+Fresh/, /Wait started\s+08:06/, /Finished\s+08:14/,
    /Wait target\s+data W1/, /Finish cutoff\s+08:15/, /Run time needed\s+2 min/);
  assert.equal(await replayFact('report-w1', 'Usable publication'), '08:12');
  assert.equal(await replayFact('report-w1', 'Scheduled start'), '08:06');
  assert.equal(await replayFact('collector-w1', 'Input freshness'), 'No inputs declared');
  assert.equal(await replayFact('report-w1', 'Started'), '08:12');
  assert.equal(await replayFact('report-w1', 'Finished'), '08:14');
  assert.equal(await replayFact('report-w1', 'Wait outcome'), 'Artifact arrived');
  assert.equal(await replayFact('report-w1', 'Time spent waiting'), '6 min');
  assert.equal(await replayFact('collector-w1', 'Time spent waiting'), null);
  const waitEventOutcome = () => evaluate("[...document.querySelectorAll('[aria-label=\"Deterministic event log\"] tbody tr')].find(row=>row.cells[1].textContent==='WaitEnd' && row.cells[2].textContent==='report-w1')?.cells[4].textContent");
  assert.equal(await waitEventOutcome(),'Fresh artifact; job started');
  const incidentTrace = () => evaluate("document.querySelector('ul.trace')?.innerText ?? ''");
  assert.match(await incidentTrace(), /BlockedWait report-w1 for data W1; planned producer: collector-w1/);
  await choose('#variant', '1');
  await has(/CH-03b/, /No usable publication by cutoff/);
  await has(/No outputs are declared for this replay/);
  assert.equal(await replayFact('report-w1', 'Run status'), 'Deadline missed');
  assert.equal(await replayFact('report-w1', 'Scheduled start'), '08:06');
  assert.equal(await replayFact('report-w1', 'Started'), 'Not started');
  assert.equal(await replayFact('report-w1', 'Finished'), 'Did not finish');
  assert.equal(await replayFact('report-w1', 'Input freshness'), 'Not read');
  assert.equal(await replayFact('report-w1', 'Usable publication'), 'None by resolution');
  assert.equal(await replayFact('report-w1', 'Policy resolved'), '08:15');
  assert.equal(await replayFact('report-w1', 'Time spent waiting'), '9 min');
  assert.match(await incidentTrace(), /DeadlineMiss report-w1 for data W1; no producer configured/);
  await choose('#variant', '2');
  await has(/CH-03c/, /Not enough time to finish/, /Finish cutoff\s+08:15/, /Run time needed\s+2 min/);
  assert.equal(await replayFact('report-w1', 'Run status'), 'Deadline missed');
  assert.equal(await replayFact('report-w1', 'Usable publication'), '08:15');
  assert.equal(await replayFact('report-w1', 'Time spent waiting'), '9 min');
  assert.match(await incidentTrace(), /DeadlineMiss report-w1 for data W1; planned producer: collector-w1/);
  assert.match(await incidentTrace(), /usable publication at 08:15 from collector-w1; earliest finish 08:17 exceeds 08:15/);
  const atCutoff = await evaluate("[...document.querySelectorAll('[aria-label=\"Deterministic event log\"] tbody tr')].filter(row=>row.cells[0].textContent==='08:15').map(row=>row.cells[1].textContent)");
  assert.deepEqual(atCutoff, ['Completion','WaitEnd']);
  assert.equal(await waitEventOutcome(),'Not enough time to finish');
  await has(/completions and publications happen first.*then cutoffs/);
  await choose('#variant','3');
  await has(/CH-03d/, /Run status\s+Failure/, /Failed without publishing/, /No usable publication by cutoff/);
  await has(/No output was published\. A job with a declared output failed/);
  assert.equal(await replayFact('collector-w1', 'Run status'), 'Failure');
  assert.equal(await replayFact('collector-w1', 'Output effect'), 'Failed without publishing data W1');
  assert.equal(await replayFact('report-w1', 'Output effect'), null);
  assert.equal(await replayFact('report-w1', 'Run status'), 'Deadline missed');
  assert.match(await incidentTrace(),/planned producer failed before publishing/);
  const outcomes = () => evaluate("[...document.querySelectorAll('[aria-label=\"Deterministic event log\"] tbody tr')].map(row=>row.lastElementChild.textContent).filter(Boolean)");
  assert((await outcomes()).includes('Failed without publishing data W1'));
  await choose('#variant','4');
  await has(/CH-03e/, /Published at 07:40, but was 35 min old at cutoff \(limit: 20 min\)/);
  assert.equal(await replayFact('report-w1','Run status'),'Deadline missed');
  assert.equal(await replayFact('report-w1','Started'),'Not started');
  assert.equal(await evaluate("new URL(location.href).searchParams.get('variant')"),'4');
  await choose('#scenario', 'duplicate');
  await has(/CH-04/, /Attempts\s+2\s+Effects\s+1/, /Suppressed.*duplicates/);
  await has(/Deduplication\s+On\s+Suppressed attempts\s+1/, /Canonical accepted attempt\s+attempt-1/);
  assert.deepEqual((await outcomes()).map(value=>value.split(' ')[0]), ['Accepted','Suppressed']);
  assert((await outcomes()).includes('Suppressed effect for result W1; duplicates attempt-1'));
  assert.equal(await replayFact('attempt-2', 'Run status'), 'Success');
  assert.equal(await replayFact('attempt-2', 'Output effect'), 'Suppressed effect for result W1; duplicates attempt-1');
  await choose('#variant', '1');
  await has(/Attempts\s+2\s+Effects\s+2/);
  await has(/Deduplication\s+Off\s+Suppressed attempts\s+0/);
  assert.match(await replayFact('attempt-2', 'Output effect'), /^Accepted effect.*result W1$/);
  assert.doesNotMatch(await text(), /Canonical accepted attempt|Suppressed.*duplicates/);
  assert.deepEqual((await outcomes()).map(value=>value.split(' ')[0]), ['Accepted','Accepted']);
  const downloads = resolve(scratch, 'downloads');
  await mkdir(downloads);
  await call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  assert(await evaluate("['export-feedback','comparison-feedback'].every(id => { const node=document.getElementById(id); return node.getAttribute('role')==='status' && !node.hidden && !node.textContent && getComputedStyle(node).display!=='none'; })"), 'Download status regions are available before their first update');
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
  assert.match(evidence.replayModel,/^clockwork-minute-v\d+$/);
  function verifyDownload(file) {
    const checked = spawnSync(process.execPath, ['--experimental-strip-types',
      'scripts/verify-evidence.mjs', file], { cwd: project, encoding:'utf8', timeout:15000, windowsHide:true });
    if (checked.error) {
      throw new Error(checked.error.code === 'ETIMEDOUT'
        ? 'Offline verification of a browser download exceeded 15 seconds.'
        : 'Could not run the offline verifier for a browser download.', { cause:checked.error });
    }
    assert.equal(checked.status,0,checked.stderr);
    assert.match(checked.stdout, /Evidence matches the replay/);
  }
  verifyDownload(resolve(downloads, filename));
  assert.match(await evaluate("document.querySelector('#export-feedback').textContent"), /Download requested:/);
  assert.equal(evidence.slots.find(s => s.attemptCount === 2).effectCount, 2);
  assert(Array.isArray(evidence.eventLog));
  assert.equal(Object.hasOwn(evidence, 'timestamp'), false);
  await choose('#variant', '0');
  assert(await evaluate("!document.querySelector('#export-feedback').textContent"));
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'No horizontal page overflow at 390px');
  await evaluate("(() => { const clone=globalThis.structuredClone; try { document.querySelector('#show-replay-link').click(); globalThis.structuredClone=()=>{throw Error('synthetic replay failure')}; document.querySelector('#replay').click(); } finally { globalThis.structuredClone=clone; } })()");
  assert(await evaluate("document.querySelector('#report [role=alert]').textContent.includes('Try Replay again') && document.querySelector('#export').disabled && document.querySelector('#show-replay-link').disabled && !document.querySelector('#export-comparison').disabled"));
  assert(await evaluate("document.querySelector('#share-tools').hidden && document.activeElement.id==='replay'"));
  assert(await evaluate("(() => {const note=document.querySelector('#share-unavailable');const share=document.querySelector('#show-replay-link');return !!note && !note.hidden && /Replay again/.test(note.textContent) && share.getAttribute('aria-describedby')===note.id;})()"),'Disabled sharing identifies the failed replay and a local recovery action');
  await evaluate("document.querySelector('#replay').click()");
  assert(await evaluate("!document.querySelector('#report [role=alert]') && !document.querySelector('#export').disabled && !document.querySelector('#show-replay-link').disabled"));
  assert(await evaluate("document.querySelector('#share-unavailable').hidden && !document.querySelector('#show-replay-link').hasAttribute('aria-describedby')"));
  const lostRegion = await evaluate("(() => {const t=document.querySelector('#report [aria-label=\"Deterministic event log\"]'); const s=document.querySelector('#scenario'); const clone=structuredClone; t.focus(); t.scrollIntoView({block:'center'}); const wasOffscreen=s.getBoundingClientRect().bottom<0; try {globalThis.structuredClone=()=>{throw new Error('synthetic scrolled replay failure')}; document.querySelector('#replay').click();} finally {globalThis.structuredClone=clone;} const rect=s.getBoundingClientRect(); return {wasOffscreen,focused:document.activeElement===s,visible:rect.top>=0&&rect.bottom<=innerHeight};})()");
  assert.deepEqual(lostRegion,{wasOffscreen:true,focused:true,visible:true},'A destroyed event region must return focus to a visible replay control');
  await evaluate("document.querySelector('#replay').click()");
  const lostShare = await evaluate("(() => { const clone=globalThis.structuredClone; const slider=document.querySelector('#arrival'); const share=document.querySelector('#show-replay-link'); share.focus(); share.scrollIntoView({block:'end'}); const wasBelow=slider.getBoundingClientRect().top>=innerHeight; try { globalThis.structuredClone=()=>{throw Error('synthetic comparison failure')}; slider.value=491; slider.dispatchEvent(new Event('input')); slider.dispatchEvent(new Event('change')); } finally { globalThis.structuredClone=clone; } const rect=slider.getBoundingClientRect(); return {wasBelow,focused:document.activeElement===slider,visible:rect.top>=0&&rect.bottom<=innerHeight}; })()");
  assert.deepEqual(lostShare,{wasBelow:true,focused:true,visible:true},'When comparison failure removes active sharing, focus must reveal the recovery control');
  assert(await evaluate("document.querySelector('#comparison [role=alert]').textContent.includes('Retry this arrival') && !document.querySelector('#retry-comparison').hidden && document.querySelector('#export-comparison').disabled && !document.querySelector('#export').disabled && new URL(location.href).searchParams.get('arrival')!=='491'"));
  assert(await evaluate("document.querySelector('#arrival-time').textContent==='08:11' && document.querySelector('#arrival').getAttribute('aria-valuetext')==='08:11'"),'A failed calculation must not leave the slider announcing a different arrival than the selected one');
  assert(await evaluate("document.querySelector('#share-tools').hidden && document.activeElement.id==='arrival'"));
  assert(await evaluate("!document.querySelector('#share-unavailable').hidden && /Retry the policy comparison/.test(document.querySelector('#share-unavailable').textContent)"),'Disabled sharing distinguishes a failed comparison from a failed replay');
  await evaluate("document.querySelector('#retry-comparison').focus()");
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
  await call('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
  assert(await evaluate("!document.querySelector('#comparison [role=alert]') && !document.querySelector('#export-comparison').disabled && document.querySelector('#retry-comparison').hidden && document.activeElement.id==='arrival' && new URL(location.href).searchParams.get('arrival')==='491' && !!document.querySelector('#policy-announcer').textContent"));
  assert(await evaluate("document.querySelector('#share-unavailable').hidden && !document.querySelector('#show-replay-link').disabled"));
  assert(await evaluate(`(() => {
    const arrival=document.querySelector('#arrival');
    const previous=document.querySelector('#comparison table');
    arrival.value='494';
    arrival.dispatchEvent(new Event('change'));
    const committed=document.querySelector('#comparison table');
    arrival.dispatchEvent(new Event('change'));
    return committed!==previous && committed===document.querySelector('#comparison table') &&
      arrival.getAttribute('aria-valuetext')==='08:14' && document.querySelector('#arrival-time').textContent==='08:14' &&
      /Deadline missed/.test(committed.innerText) && new URL(location.href).searchParams.get('arrival')==='494';
  })()`),'A change-only arrival commits a fresh comparison once');
  await evaluate("(() => { const slider=document.querySelector('#arrival'); slider.value=492; slider.dispatchEvent(new Event('input')); slider.dispatchEvent(new Event('change')); })()");
  assert.deepEqual(errors, []);
  const beforePolicyLink = await evaluate('location.href');
  const beforeResultsJump = await evaluate("document.querySelector('#report .facts').textContent");
  assert.equal(await evaluate("document.querySelector('#view-replay-results')?.getAttribute('href')"),'#report',
    'The replay controls need a route to their results that bypasses the separate policy lab.');
  await evaluate("document.querySelector('#view-replay-results').focus()");
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  assert(await evaluate("location.hash==='#report' && document.activeElement.id==='report' && document.querySelector('#report .facts').getBoundingClientRect().top<innerHeight"));
  assert.equal(await evaluate("document.querySelector('#report .facts').textContent"),beforeResultsJump);
  assert.equal(await evaluate("location.search"),new URL(beforePolicyLink).search);
  assert.equal(await evaluate("document.querySelector('#return-to-replay')?.getAttribute('href')"),'#replay-title',
    'After inspecting the event log, users need a direct route back to the replay controls.');
  await evaluate("document.querySelector('#return-to-replay').focus()");
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  assert(await evaluate("location.hash==='#replay-title' && document.activeElement.id==='replay-title'"));
  assert.equal(await evaluate("document.querySelector('#report .facts').textContent"),beforeResultsJump);
  assert.equal(await evaluate("location.search"),new URL(beforePolicyLink).search);
  await evaluate("history.replaceState(null,''," + JSON.stringify(beforePolicyLink) + ")");
  await evaluate("document.querySelector('#try-policy-lab').focus()");
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  assert(await evaluate("location.hash==='#compare-title' && document.activeElement.id==='compare-title' && document.querySelector('#comparison table')"));
  await evaluate("document.querySelector('#show-cutoff-miss').focus()");
  await call('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
  await call('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
  const cutoffActivated = "document.querySelector('#arrival').value==='494' && /Deadline missed/.test(document.querySelector('#comparison').innerText)";
  for(let i=0;i<20 && !(await evaluate(cutoffActivated));i++) await delay(25);
  assert(await evaluate(cutoffActivated));
  assert(await evaluate("/not enough time.*Earliest possible finish: 08:16.*08:08 using W0/.test(document.querySelector('#policy-summary').innerText)"));
  assert(await evaluate("/Fresh artifact for wait policy\\s+No wait policy\\s+W1 from collector-w1; published and checked at 08:14/.test(document.querySelector('#comparison').innerText)"));
  assert(await evaluate("document.activeElement.id==='show-cutoff-miss' && document.querySelector('#policy-announcer').getAttribute('role')==='status' && document.querySelector('#policy-announcer').textContent===document.querySelector('#policy-summary').textContent"));
  await evaluate("document.querySelector('#show-tradeoff').click()");
  assert(await evaluate("document.querySelector('#arrival').value==='492' && /Stale/.test(document.querySelector('#comparison').innerText) && /Fresh/.test(document.querySelector('#comparison').innerText)"));
  assert(await evaluate("/finishes 6 minutes later/.test(document.querySelector('#policy-summary').innerText)"));
  await evaluate("history.replaceState(null,''," + JSON.stringify(beforePolicyLink) + ")");
  console.log('PASS Chrome: CH-01 through CH-04, both deadline misses, dedupe toggle, replay, JSON download, 390px layout');
  if (runAudit) {
    let number = 25;
    const audit = async (name, check) => {
      const n = ++number;
      assert(await check(), 'Audit ' + n + ' failed: ' + name);
      console.log('PASS Audit ' + n + ': ' + name);
    };
    const compare = () => evaluate("document.querySelector('#comparison').innerText");
    const slider = (value) => evaluate("(() => { const s=document.querySelector('#arrival'); s.value=" + value + "; s.dispatchEvent(new Event('input')); })()");
    assert(await evaluate("(() => { const s=document.querySelector('#arrival'); const before=document.querySelector('#comparison table'); for(let i=0;i<100;i++)s.dispatchEvent(new Event('input')); return before===document.querySelector('#comparison table'); })()"), 'Repeated input events for the same minute preserve the completed comparison');
    await audit('initialization enables ready controls without retaining the loading notice', () => evaluate("document.documentElement.dataset.ready==='true' && document.querySelector('#startup-loading').hidden && !document.querySelector('#replay').disabled && !document.querySelector('#export').disabled"));
    await audit('document declares English', () => evaluate("document.documentElement.lang === 'en'"));
    await audit('replayed clock times do not depend on the browser time zone', async () => {
      const initialZone = await evaluate('Intl.DateTimeFormat().resolvedOptions().timeZone');
      const differentZone = initialZone === 'Pacific/Honolulu' ? 'Asia/Tokyo' : 'Pacific/Honolulu';
      const before = await compare();
      try {
        await call('Emulation.setTimezoneOverride', { timezoneId:differentZone });
        await slider(493);
        await slider(492);
        return await evaluate("Intl.DateTimeFormat().resolvedOptions().timeZone === " + JSON.stringify(differentZone)) &&
          (await compare()) === before &&
          await evaluate("/simulated clock, not in your local time zone/.test(document.querySelector('.policy-notes').textContent)");
      } finally {
        await call('Emulation.setTimezoneOverride', { timezoneId:'' });
      }
    });
    await audit('page metadata describes the working demo without a private deployment link', () => evaluate("(() => { const meta=selector=>document.querySelector(selector)?.content; const description=meta('meta[name=description]'); return document.title.startsWith('Clockwork Haunt') && meta('meta[property=\"og:title\"]')===document.title && meta('meta[property=\"og:description\"]')===description && /fresh data.*reproducible evidence/.test(description) && !document.querySelector('meta[property=\"og:url\"]'); })()"));
    await audit('all live DOM ids are unique', () => evaluate("new Set([...document.querySelectorAll('[id]')].map(x=>x.id)).size===document.querySelectorAll('[id]').length"));
    await audit('print retains all evidence columns and the active replay and comparison identities', async () => {
      const [priorScenario,priorVariant,priorUrl] = await evaluate("[document.querySelector('#scenario').value,document.querySelector('#variant').value,location.href]");
      try {
        await choose('#scenario','late');
        await choose('#variant','0');
        await call('Emulation.setEmulatedMedia',{media:'print'});
        const printed = await evaluate(`(() => {
          const regions = [...document.querySelectorAll('#report .scroll, #comparison .scroll')];
          const layout = regions.map(region => {
            const bounds = region.getBoundingClientRect();
            const cols = [...region.querySelectorAll('thead th')].map(col => col.getBoundingClientRect());
            return [getComputedStyle(region).overflowX, cols.length,
              cols.every(col => col.left >= bounds.left - 1 && col.right <= bounds.right + 1)];
          });
          return {layout, paper:getComputedStyle(document.body).backgroundColor,
            replay:document.querySelector('#report h2').innerText,
            arrival:document.querySelector('#arrival-time').innerText,
            replayButton:document.querySelector('#replay').getClientRects().length,
            returnLink:document.querySelector('#return-to-replay').getClientRects().length};
        })()`);
        assert(printed.layout.some(([,count])=>count>=8) &&
          printed.layout.every(([overflow,count,fits])=>overflow==='visible' && count>0 && fits) &&
          printed.paper==='rgb(255, 255, 255)' && /previous window/.test(printed.replay) &&
          printed.arrival==='08:12' && printed.replayButton===0 && printed.returnLink===0, JSON.stringify(printed));
        const pdf = await call('Page.printToPDF',{printBackground:false});
        return Buffer.from(pdf.data,'base64').subarray(0,5).toString()==='%PDF-';
      } finally {
        await call('Emulation.setEmulatedMedia',{media:''});
        await choose('#scenario',priorScenario);
        await choose('#variant',priorVariant);
        await evaluate("history.replaceState(null,''," + JSON.stringify(priorUrl) + ")");
      }
    });
    await audit('static policy blocks even same-origin connections', () => evaluate("(async () => { const observed = new Promise(resolve=>{ const listener=event=>{if(event.effectiveDirective==='connect-src'){clearTimeout(timer);document.removeEventListener('securitypolicyviolation',listener);resolve(event.disposition==='enforce');}}; const timer=setTimeout(()=>{document.removeEventListener('securitypolicyviolation',listener);resolve(false);},1500); document.addEventListener('securitypolicyviolation',listener); }); const blocked=await fetch(new URL('icon.svg',location.href)).then(()=>false,()=>true); return blocked && await observed; })()"));
    await call('Emulation.setDeviceMetricsOverride', { width: 320, height: 740, deviceScaleFactor: 1, mobile: true });
    await audit('320px page has no global horizontal overflow', () => evaluate('document.documentElement.scrollWidth <= window.innerWidth'));
    await audit('arrival slider has a 44px pointer target at narrow widths', () => evaluate("(() => {const slider=document.querySelector('#arrival'); slider.scrollIntoView({block:'center'}); const r=slider.getBoundingClientRect(); return r.height>=44 && document.elementFromPoint(r.left+r.width/2,r.top+3)===slider && document.elementFromPoint(r.left+r.width/2,r.bottom-3)===slider;})()"));
    await audit('200 percent root text size still reflows the 320px app', async () => {
      const layout = await evaluate("(() => { const root=document.documentElement; const prior=root.style.fontSize; try { root.style.fontSize='200%'; return {text:parseFloat(getComputedStyle(root).fontSize),page:root.scrollWidth,viewport:innerWidth,overflow:[...document.querySelectorAll('.panel')].filter(panel=>panel.scrollWidth>panel.clientWidth).map(panel=>[panel.querySelector('h2')?.textContent,panel.scrollWidth,panel.clientWidth])}; } finally { root.style.fontSize=prior; } })()");
      assert(layout.text>=32 && layout.page<=320 && layout.viewport<=320 && !layout.overflow.length,JSON.stringify(layout));
      return true;
    });
    await audit('all replay presets and the share field fit at enlarged text size', async () => {
      const [font,oldScenario,oldVariant,oldUrl] = await evaluate("[document.documentElement.style.fontSize,document.querySelector('#scenario').value,document.querySelector('#variant').value,location.href]");
      const fits = () => evaluate("document.documentElement.scrollWidth<=320 && [...document.querySelectorAll('.panel')].every(p=>p.scrollWidth<=p.clientWidth)");
      try {
        await evaluate("document.documentElement.style.fontSize='200%'");
        for (const [value,count] of [['fresh',1],['late',2],['wait',4],['duplicate',2]]) {
          await choose('#scenario',value);
          for (let i=0;i<count;i++) {
            await choose('#variant',String(i));
            assert(await fits(),'Enlarged replay overflows: '+value+'/'+i);
          }
        }
        await evaluate("document.querySelector('#show-replay-link').click()");
        assert(await fits(),'Enlarged replay with the share field open overflows');
        return await evaluate("document.activeElement.id==='replay-link' && document.activeElement.value.includes('scenario=duplicate')");
      } finally {
        await evaluate("document.documentElement.style.fontSize="+JSON.stringify(font)+"; if(!document.querySelector('#share-tools').hidden)document.querySelector('#show-replay-link').click()");
        await choose('#scenario',oldScenario);
        await choose('#variant',oldVariant);
        await evaluate("history.replaceState(null,'',"+JSON.stringify(oldUrl)+")");
      }
    });
    for (const [name, total] of [['fresh',1],['late',2],['wait',4],['duplicate',2]]) {
      await choose('#scenario', name);
      for (let index=0; index<total; index++) {
        await choose('#variant', String(index));
        assert(await evaluate("document.documentElement.scrollWidth<=window.innerWidth && [...document.querySelectorAll('#report .panel')].every(panel=>panel.scrollWidth<=panel.clientWidth)"), 'Replay panel overflows at 320px: ' + name + '/' + index);
      }
    }
    assert(await evaluate("(() => { const selected = document.querySelector('#report dd.good'); const before=selected.textContent; selected.textContent='output-attempt-'+'A'.repeat(160); const ok=document.documentElement.scrollWidth<=window.innerWidth && selected.scrollWidth<=selected.clientWidth; selected.textContent=before; return ok; })()"), 'A long unbroken attempt identifier wraps inside its run card');
    await choose('#scenario', 'late');
    await audit('replacing a focused forensic table preserves its available horizontal position', () => evaluate("(() => {const find=()=>document.querySelector('#report [aria-label=\"Deterministic event log\"]');const before=find();before.focus();before.scrollLeft=40;const left=before.scrollLeft;const variant=document.querySelector('#variant');variant.value='1';variant.dispatchEvent(new Event('change'));const after=find();return left>0 && after!==before && document.activeElement===after && after.scrollLeft===Math.min(left,after.scrollWidth-after.clientWidth);})()"));
    await audit('named table regions enter the tab order only if they overflow', () => evaluate("(() => { const regions = [...document.querySelectorAll('.scroll[role=region][aria-label]')]; return regions.some(r => r.tabIndex===0) && regions.every(r => r.tabIndex === (r.scrollWidth>r.clientWidth ? 0 : -1)); })()"));
    await audit('overflowing forensic tables advertise additional columns without adding a hint to fitting tables', () => evaluate("(() => {const regions=[...document.querySelectorAll('.scroll[role=region]')]; return regions.some(region=>region.scrollWidth>region.clientWidth) && regions.every(region=>{const hint=region.previousElementSibling;const overflow=region.scrollWidth>region.clientWidth;return hint?.classList.contains('table-scroll-hint') && hint.hidden!==overflow && (hint.getBoundingClientRect().height>0)===overflow && region.getAttribute('aria-describedby')===(overflow?hint.id:null) && /more columns/.test(hint.textContent);});})()"));
    await audit('comparison table pairs caption, column labels and one scoped measure label per row', () => evaluate("(() => { const table=document.querySelector('#comparison table'); return !!table.caption && [...table.tHead.rows[0].cells].every(x=>x.scope==='col') && [...table.tBodies[0].rows].every(row=>row.cells[0].scope==='row' && row.cells[0].textContent.trim() && row.cells[1].tagName==='TD' && row.cells[2].tagName==='TD'); })()"));
    await audit('both policy columns are visible at 320px without horizontal swiping', () => evaluate("(() => { const region=document.querySelector('#comparison .scroll'); const cols=[...region.querySelectorAll('thead th')]; const shown=region.getBoundingClientRect(); return cols.length===3 && region.scrollWidth===region.clientWidth && cols.slice(1).every(col=>{const rect=col.getBoundingClientRect(); return rect.left>=shown.left && rect.right<=shown.right+1 && rect.width>=65;}); })()"));
    await choose('#scenario', 'fresh');
    await audit('single-preset scenario hides variant selector', () => evaluate("document.querySelector('#variant-label').hidden"));
    await choose('#scenario', 'wait');
    await audit('wait selector preserves four existing choices and offers an expired input', () => evaluate("!document.querySelector('#variant-label').hidden && [...document.querySelector('#variant').options].map(x=>x.value+':'+x.text).join('|')==='0:Arrives at 08:12|1:Never arrives|2:Arrives at 08:15|3:Collector fails|4:Input is already too old'"));
    await choose('#variant', '2');
    await choose('#scenario', 'duplicate');
    await audit('new scenario resets the old variant to first valid choice', () => evaluate("document.querySelector('#variant').value==='0'"));
    await audit('policy lab default shows 08:08 versus 08:14', async () => /Report finishes\s+08:08\s+08:14/.test(await compare()));
    await audit('policy lab distinguishes stale and fresh at a glance', async () => /Input freshness\s+Stale\s+Fresh/.test(await compare()));
    assert.match(await compare(), /Window used\s+W0\s+W1/);
    assert.match(await compare(), /Read from attempt\s+preload-w0\s+collector-w1/);
    assert.match(await compare(), /Read at\s+08:06\s+08:12/);
    assert.match(await compare(), /Read age \(minutes\)\s+26\s+0/);
    await evaluate("(() => {const summary=document.querySelector('.policy-notes summary');summary.focus();summary.click();})()");
    const freshnessNote = await evaluate("(() => {const rule=document.querySelector('#policy-freshness-rule'); return {open:document.querySelector('.policy-notes').open,hidden:rule.hidden,text:rule.innerText,focus:document.activeElement.tagName};})()");
    assert(freshnessNote.open && !freshnessNote.hidden && /no more than 60 minutes[\s\S]*prior window is still stale/.test(freshnessNote.text),JSON.stringify(freshnessNote));
    await evaluate("document.querySelector('.policy-notes').open=false");
    await slider(493);
    await audit('08:13 arrival completes exactly at 08:15', async () => /Report finishes\s+08:08\s+08:15/.test(await compare()));
    assert.match(await compare(), /Finish relative to 08:15\s+7 min before\s+At cutoff/);
    await slider(494);
    await audit('one minute later flips waiting to a miss', async () => /Run outcome\s+Success\s+Deadline missed/.test(await compare()));
    assert.match(await compare(), /Window used\s+W0\s+Not read/);
    assert.match(await compare(), /Read from attempt\s+preload-w0\s+Not read/);
    assert.match(await compare(), /Report starts\s+08:06\s+Not started/);
    assert.match(await compare(), /Report finishes\s+08:08\s+Did not finish/);
    assert.match(await compare(), /Read at\s+08:06\s+Not read/);
    assert.match(await compare(), /Finish relative to 08:15\s+7 min before\s+Did not finish/);
    assert.match(await compare(), /not enough time to finish/);
    await slider(496);
    assert.match(await compare(), /arrival is after the 08:15 cutoff/);
    await slider(484);
    assert.match(await compare(), /W1 from collector-w1; published 08:04, checked 08:06/);
    await slider(486);
    await audit('equal-minute arrival is fresh for both policies', async () => /Input freshness\s+Fresh\s+Fresh/.test(await compare()));
    await audit('slider value is announced as a clock time', () => evaluate("document.querySelector('#arrival').getAttribute('aria-valuetext')==='08:06'"));
    await call('DOM.enable');
    const dom = await call('DOM.getDocument');
    const sliderNode = await call('DOM.querySelector', { nodeId: dom.root.nodeId, selector:'#arrival' });
    const sliderTree = await call('Accessibility.queryAXTree', { nodeId:sliderNode.nodeId, role:'slider' });
    assert.equal(sliderTree.nodes[0]?.name?.value, 'Collector arrival');
    assert.equal(sliderTree.nodes[0].role.value, 'slider');
    assert.equal(sliderTree.nodes[0].value.value, 486);
    assert.equal(sliderTree.nodes[0].description.value, '08:04 to 08:18');
    await evaluate("document.querySelector('#arrival').focus()");
    await call('Input.dispatchKeyEvent',{ type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await call('Input.dispatchKeyEvent',{ type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
    await audit('keyboard arrow changes collector arrival by one minute', () => evaluate("document.querySelector('#arrival').value==='487'"));
    await audit('repaint keeps focus on the slider', () => evaluate("document.activeElement.id==='arrival'"));
    await audit('native keyboard endpoints reach both bounds and commit their rendered state', async () => {
      for (const [key,windowsVirtualKeyCode,minute,clock,outcome] of [
        ['End',35,498,'08:18','Deadline missed'], ['Home',36,484,'08:04','Success'],
      ]) {
        for (const type of ['keyDown','keyUp']) await call('Input.dispatchKeyEvent',{type,key,code:key,windowsVirtualKeyCode});
        const read = await evaluate("(() => { const slider=document.querySelector('#arrival'); const row=[...document.querySelectorAll('#comparison tr')].find(row=>row.cells[0]?.textContent==='Run outcome'); return [slider.valueAsNumber,slider.getAttribute('aria-valuetext'),row.lastElementChild.textContent,Number(new URL(location.href).searchParams.get('arrival')),document.activeElement===slider]; })()");
        assert.deepEqual(read,[minute,clock,outcome,minute,true]);
      }
      return true;
    });
    await audit('forced colors retain focus and non-color outcome cues', async () => {
      try {
        await call('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value:'active'}]});
        await slider(494);
        return await evaluate("(() => {const slider=document.querySelector('#arrival'); const style=getComputedStyle(slider); const panel=document.querySelector('#comparison'); return matchMedia('(forced-colors: active)').matches && document.activeElement===slider && style.outlineStyle!=='none' && parseFloat(style.outlineWidth)>=3 && /Deadline missed/.test(panel.textContent) && /Earliest possible finish: 08:16/.test(panel.textContent);})()");
      } finally {
        await call('Emulation.setEmulatedMedia',{features:[]});
        await slider(484);
      }
    });
    let comparisonBefore = await compare();
    await evaluate("document.querySelector('#replay').click()");
    await audit('scenario replay does not reset policy comparison', async () => await compare() === comparisonBefore);
    await choose('#variant', '1');
    await audit('changing dedupe preset updates status without changing comparison', async () => /Effects\s+2/.test(await text()) && await compare() === comparisonBefore);
    await audit('browser download declares evidence schema version', () => evidence.schemaVersion === 1);
    await audit('browser download includes the actual selected input', () => evidence.input?.scenarioId === evidence.scenarioId && evidence.input.jobs.some(job => job.deduplicationEnabled === false));
    const luminance = rgb => rgb.match(/\d+/g).slice(0,3).map(Number).map(n => n / 255)
      .map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4)
      .reduce((sum,x,index)=>sum+x*[.2126,.7152,.0722][index],0);
    const contrast = (a,b) => {
      const first = luminance(a), second = luminance(b);
      return (Math.max(first,second)+.05)/(Math.min(first,second)+.05);
    };
    await audit('control boundary exceeds 3:1 against the panel', async () => {
      const [border, panel] = await evaluate("[getComputedStyle(document.querySelector('#export')).borderTopColor,getComputedStyle(document.querySelector('.controls')).backgroundColor]");
      return contrast(border,panel)>=3;
    });
    const statusContrast = async (tone, expected) => {
      const info = await evaluate(`(() => {
        const node = [...document.querySelectorAll('#report dd.' + ${JSON.stringify(tone)})]
          .find(element => element.textContent === ${JSON.stringify(expected)});
        return node ? [getComputedStyle(node).color,getComputedStyle(node.closest('.panel')).backgroundColor] : null;
      })()`);
      assert(info, 'Visible status text not found: ' + expected);
      assert(contrast(...info)>=4.5, 'Status contrast fell below 4.5:1: ' + expected);
    };
    await choose('#scenario', 'late');
    await statusContrast('good','Success');
    await statusContrast('warn','Stale');
    await choose('#scenario', 'wait');
    await choose('#variant', '3');
    await statusContrast('bad','Failure');
    await choose('#scenario', 'duplicate');
    await choose('#variant', '1');
    console.log('PASS contrast: visible success, warning and failure text reaches 4.5:1');
    await audit('loaded app assets stay inside the project with required entry and stylesheet present', () => evaluate(`(() => {
      const base = new URL('./',location.href);
      const resources = performance.getEntriesByType('resource').map(entry=>new URL(entry.name));
      // Actual JSON downloads use same-origin object URLs rather than a hosted path.
      const owns = candidate => candidate.origin===base.origin &&
        (candidate.protocol==='blob:' || candidate.pathname.startsWith(base.pathname));
      return resources.every(owns) && ['ui/app.js','style.css'].every(relative =>
        resources.some(candidate=>candidate.href===new URL(relative,base).href));
    })()`));
    await slider(493);
    // Changing the raw control without its input event must not export data
    // that differs from the comparison still on screen.
    await evaluate("document.querySelector('#arrival').value=494");
    await evaluate("document.querySelector('#export-comparison').click()");
    const comparisonFile = resolve(downloads, 'clockwork-policy-comparison-0813.json');
    let comparisonExport;
    for(let i=0;i<60 && !comparisonExport;i++) {
      try { comparisonExport = JSON.parse(await readFile(comparisonFile, 'utf8')); }
      catch { await delay(100); }
    }
    assert.equal(comparisonExport.kind, 'policy-comparison');
    assert.equal(comparisonExport.arrival, 493);
    assert.deepEqual(comparisonExport.runOnSchedule.input.preloadedArtifacts, comparisonExport.waitForFresh.input.preloadedArtifacts);
    assert.deepEqual(comparisonExport.runOnSchedule.input.jobs[0], comparisonExport.waitForFresh.input.jobs[0]);
    assert.equal(comparisonExport.runOnSchedule.runs.find(x=>x.jobId==='report-w1').completionMinute,488);
    assert.equal(comparisonExport.waitForFresh.runs.find(x=>x.jobId==='report-w1').completionMinute,495);
    verifyDownload(comparisonFile);
    const feedbackVisible = "Boolean(document.querySelector('#comparison-feedback').textContent)";
    assert(await evaluate(feedbackVisible));
    await choose('#scenario', 'fresh');
    assert(await evaluate(feedbackVisible), 'Unrelated replay does not invalidate comparison feedback');
    await slider(492);
    assert.equal(await evaluate(feedbackVisible), false, 'Changing arrival clears old comparison feedback');
    console.log('PASS bonus: actual comparison JSON download preserves shared inputs and policy outcomes');
    await evaluate("(() => { const create=URL.createObjectURL; try { URL.createObjectURL=()=>{throw Error('simulated download failure')}; document.querySelector('#export-comparison').click(); } finally { URL.createObjectURL=create; } })()");
    assert.match(await evaluate("document.querySelector('#comparison-feedback').innerText"), /Could not start the JSON download/);
    assert.equal(await evaluate("document.querySelectorAll('a[download]').length"),0);
    const failedAfterCreate = await evaluate(`(() => {
      const click=HTMLAnchorElement.prototype.click, create=URL.createObjectURL, revoke=URL.revokeObjectURL;
      let freshUrl, revokes=0;
      try {
        URL.createObjectURL=blob=>(freshUrl=create.call(URL,blob));
        URL.revokeObjectURL=url=>{if(url===freshUrl) revokes++; revoke.call(URL,url);};
        HTMLAnchorElement.prototype.click=function() {
          if(this.hasAttribute('download')) throw Error('simulated handoff failure');
          return click.call(this);
        };
        document.querySelector('#export-comparison').click();
        return {created:!!freshUrl,revokes,anchors:document.querySelectorAll('a[download]').length,
          feedback:/Could not start/.test(document.querySelector('#comparison-feedback').textContent)};
      } finally {
        HTMLAnchorElement.prototype.click=click; URL.createObjectURL=create; URL.revokeObjectURL=revoke;
      }
    })()`);
    assert.deepEqual(failedAfterCreate,{created:true,revokes:1,anchors:0,feedback:true});
    console.log('PASS bonus: failed download leaves actionable feedback and no dangling anchor');
    await choose('#scenario', 'wait');
    await choose('#variant', '2');
    await slider(494);
    await evaluate("document.querySelector('#arrival').dispatchEvent(new Event('change'))");
    await call('Page.reload', { ignoreCache: true });
    const restored = "document.documentElement.dataset.ready==='true' && document.querySelector('#scenario').value==='wait' && document.querySelector('#variant').value==='2' && document.querySelector('#arrival').value==='494'";
    for(let i=0;i<70 && !(await evaluate(restored));i++) await delay(50);
    assert(await evaluate(restored), 'Reload restores the exact shareable preset, variant and arrival');
    console.log('PASS bonus: replay settings survive an actual browser reload');
    await slider(495);
    await evaluate("document.querySelector('#arrival').dispatchEvent(new Event('change'))");
    await evaluate("window.keptReport = document.querySelector('#report .scroll'); window.keptVariant = document.querySelector('#variant option'); window.keptReport.focus()");
    await evaluate('history.back()');
    for(let i=0;i<50 && !(await evaluate(restored));i++) await delay(50);
    assert(await evaluate(restored), 'Back restores the previous committed replay state');
    assert(await evaluate("document.querySelector('#report .scroll')===window.keptReport && document.querySelector('#variant option')===window.keptVariant && document.activeElement===window.keptReport"), 'Arrival-only history navigation leaves replay content, options and focused region intact');
    await evaluate('history.forward()');
    const advanced = "document.querySelector('#arrival').value==='495'";
    for(let i=0;i<50 && !(await evaluate(advanced));i++) await delay(50);
    assert(await evaluate(advanced), 'Forward restores the next committed replay state');
    await evaluate("document.querySelector('#comparison .scroll').focus(); history.back()");
    for(let i=0;i<50 && !(await evaluate(restored));i++) await delay(50);
    assert(await evaluate("document.activeElement===document.querySelector('#comparison .scroll')"), 'Comparison focus follows its replacement when the minute changes');
    await evaluate('history.forward()');
    for(let i=0;i<50 && !(await evaluate(advanced));i++) await delay(50);
    assert(await evaluate(advanced));
    console.log('PASS bonus: actual Back and Forward restore replay settings');
    await evaluate("(() => { const url=new URL(location.href); url.searchParams.set('unrelated','example'); url.hash='old-anchor'; history.replaceState(null,'',url); document.querySelector('#variant').value='1'; document.querySelector('#arrival').value=493; document.querySelector('#show-replay-link').click(); })()");
    const shareLink = new URL(await evaluate("document.querySelector('#replay-link').value"));
    assert.deepEqual([...shareLink.searchParams.entries()],[['scenario','wait'],['variant','2'],['arrival','495']]);
    assert.equal(shareLink.hash,'');
    assert.equal(shareLink.pathname,pagesMount,'Shared judge links retain the deployed project path');
    await evaluate("document.querySelector('#variant').value='2'; document.querySelector('#arrival').value=495;");
    assert.equal(await evaluate("document.activeElement.id"),'replay-link');
    await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    assert(await evaluate("document.querySelector('#share-tools').hidden && document.activeElement.id==='show-replay-link' && document.activeElement.getAttribute('aria-expanded')==='false'"));
    await evaluate("document.querySelector('#show-replay-link').click()");
    assert(await evaluate("!document.querySelector('#share-tools').hidden && document.activeElement.id==='replay-link'"));
    const clipboardOk = await evaluate("(async () => { let copied; Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{copied=value}}}); try { document.querySelector('#copy-replay-link').click(); await Promise.resolve(); return copied===document.querySelector('#replay-link').value && document.querySelector('#share-feedback').textContent==='Replay link copied.'; } finally { delete navigator.clipboard; } })()");
    assert(clipboardOk, 'Copy writes only the visible scoped URL');
    const slowCopy = await evaluate("(async () => {let settle;const button=document.querySelector('#copy-replay-link');const status=document.querySelector('#share-feedback');Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>new Promise(resolve=>{settle=resolve})}});try{button.click();const replaced=/Copying replay link/.test(status.textContent);await new Promise(resolve=>setTimeout(resolve,1350));const fallback=/Still waiting.*copy it manually/.test(status.textContent);settle();await Promise.resolve();return replaced && fallback && status.textContent==='Replay link copied.';} finally {delete navigator.clipboard;}})()");
    assert(slowCopy,'An unresolved copy clears any old success and offers a manual route before actual confirmation');
    const clipboardDenied = await evaluate("(async () => { Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async ()=>{throw Error('synthetic denial')}}}); try { document.querySelector('#copy-replay-link').click(); await Promise.resolve(); const field=document.querySelector('#replay-link'); return document.activeElement===field && field.selectionStart===0 && field.selectionEnd===field.value.length && document.querySelector('#share-feedback').textContent.includes('copy it manually'); } finally { delete navigator.clipboard; } })()");
    assert(clipboardDenied, 'Clipboard denial leaves the URL selected and gives manual guidance');
    const movedCopy = await evaluate("(async () => {let fail;const copy=document.querySelector('#copy-replay-link');const slider=document.querySelector('#arrival');Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>new Promise((_,reject)=>{fail=reject})}});try{copy.focus();copy.click();slider.focus();fail(new Error('synthetic delayed denial'));await Promise.resolve();return document.activeElement===slider && /copy it manually/.test(document.querySelector('#share-feedback').textContent);}finally{delete navigator.clipboard;}})()");
    assert(movedCopy,'A delayed clipboard denial may explain manual copy but must not steal focus');
    const staleCopy = await evaluate("(async () => { let finish; Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>new Promise(resolve=>{finish=resolve})}}); const slider=document.querySelector('#arrival'); try { document.querySelector('#copy-replay-link').click(); slider.value=494; slider.dispatchEvent(new Event('input')); slider.focus(); finish(); await Promise.resolve(); return new URL(document.querySelector('#replay-link').value).searchParams.get('arrival')==='494' && !document.querySelector('#share-feedback').textContent && document.activeElement===slider; } finally { delete navigator.clipboard; slider.value=495; slider.dispatchEvent(new Event('input')); } })()");
    assert(staleCopy, 'A delayed copy cannot announce success on a newer URL or steal slider focus');
    const closedCopy = await evaluate("(async () => { let fail; Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>new Promise((_,reject)=>{fail=reject})}}); try { document.querySelector('#copy-replay-link').click(); document.querySelector('#show-replay-link').click(); fail(Error('synthetic late denial')); await Promise.resolve(); return document.querySelector('#share-tools').hidden && !document.querySelector('#share-feedback').textContent && document.activeElement.id==='show-replay-link'; } finally { delete navigator.clipboard; } })()");
    assert(closedCopy, 'Closing the share panel invalidates a pending denial without refocusing hidden content');
    await evaluate("document.querySelector('#show-replay-link').click()");
    console.log('PASS bonus: deliberately shared link contains only replay settings');
    await choose('#scenario', 'late');
    await choose('#variant', '1');
    assert(await evaluate("(() => { const status=document.querySelector('#replay-location-feedback'); return status.getAttribute('role')==='status' && !status.hidden && getComputedStyle(status).display!=='none' && !status.textContent; })()"));
    const beforeBlockedHistory = await evaluate('location.href');
    await evaluate("(() => { const push=history.pushState; try { history.pushState=()=>{throw new DOMException('synthetic history limit','SecurityError')}; const variant=document.querySelector('#variant'); variant.value='0'; variant.dispatchEvent(new Event('change')); } finally { history.pushState=push; } })()");
    assert.equal(await evaluate('location.href'),beforeBlockedHistory);
    assert(await evaluate("document.querySelector('#replay-location-feedback').textContent.includes('history could not update') && !document.querySelector('#export').disabled"));
    assert.equal(new URL(await evaluate("document.querySelector('#replay-link').value")).searchParams.get('variant'),'0');
    await choose('#variant', '1');
    assert(await evaluate("!document.querySelector('#replay-location-feedback').textContent"));
    const lateLink = await evaluate("document.querySelector('#replay-link').value");
    await call('Page.navigate', { url: lateLink });
    const lateRestored = "document.documentElement.dataset.ready==='true' && document.querySelector('#share-tools').hidden && document.querySelector('#report h2')?.textContent.startsWith('CH-02-no-fallback') && document.querySelector('#variant').value==='1'";
    for(let i=0;i<60 && !(await evaluate(lateRestored));i++) await delay(50);
    assert(await evaluate(lateRestored), 'A shared URL opens the exact no-fallback variant on a fresh page');
    await evaluate("document.querySelector('#export').click()");
    const lateEvidencePath = resolve(downloads, 'CH-02-no-fallback-evidence.json');
    let lateEvidence;
    for(let i=0;i<60 && !lateEvidence;i++){
      try { lateEvidence = JSON.parse(await readFile(lateEvidencePath, 'utf8')); }
      catch { await delay(50); }
    }
    assert.equal(lateEvidence?.runs.find(run=>run.jobId==='report-w1').reads[0].unavailableReason, 'PublicationPending');
    verifyDownload(lateEvidencePath);
    await call('Page.navigate', { url: previewUrl.slice(0,-1) + '?scenario=late&variant=0&arrival=492#compare-title' });
    const walkthrough = "document.documentElement.dataset.ready==='true' && location.pathname.endsWith('/') && location.hash==='#compare-title' && document.querySelector('#arrival').value==='492' && /6 minutes later/.test(document.querySelector('#policy-summary')?.textContent ?? '')";
    for(let i=0;i<60 && !(await evaluate(walkthrough));i++) await delay(50);
    assert(await evaluate(walkthrough), 'Recording deep link begins at the working first trade-off');
    assert(await evaluate("(() => { const summary=document.querySelector('#policy-summary').getBoundingClientRect(); const notes=document.querySelector('.policy-notes'); return summary.top>=0 && summary.bottom<=innerHeight && !notes.open; })()"),'The decision summary is readable on the initial 320px lab view without opening detailed notes');
    await call('Network.enable');
    const internet = offline => call('Network.emulateNetworkConditions', {
      offline, latency:0, downloadThroughput:offline ? 0 : -1, uploadThroughput:offline ? 0 : -1,
    });
    await internet(true);
    try {
      assert.equal(await evaluate('navigator.onLine'),false);
      await evaluate("document.querySelector('#show-cutoff-miss').click(); document.querySelector('#export-comparison').click()");
      const cutoffFile = resolve(downloads,'clockwork-policy-comparison-0814.json');
      let cutoffEvidence;
      for(let i=0;i<60 && !cutoffEvidence;i++){
        try { cutoffEvidence=JSON.parse(await readFile(cutoffFile,'utf8')); }
        catch { await delay(50); }
      }
      assert.equal(cutoffEvidence?.arrival,494);
      const cutoffReport = cutoffEvidence.waitForFresh.runs.find(run=>run.jobId==='report-w1');
      assert.equal(cutoffReport?.completionStatus,'DeadlineMissed');
      assert.deepEqual(cutoffReport.reads,[]);
      assert.deepEqual(cutoffReport.policyArtifact,{key:'data',windowIndex:1,producerAttemptId:'collector-w1',
        publishMinute:494,decisionMinute:494,ageAtDecision:0});
      assert.equal(cutoffEvidence.waitForFresh.trace.find(row=>row.kind==='DeadlineMiss')?.detail.earliestFinish,496);
      verifyDownload(cutoffFile);
      console.log('PASS judge rehearsal: direct link, cutoff interaction and verified download without network after load');
    } finally {
      await internet(false);
    }
    await evaluate("document.querySelector('a[href=\"#replay-title\"]').focus()");
    for (const type of ['keyDown','keyUp']) await call('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    assert(await evaluate("location.hash==='#replay-title' && document.activeElement.id==='replay-title' && !document.querySelector('#scenario').disabled && document.querySelector('#arrival').value==='494'"),'The compare-to-replay link restores a useful focus target without resetting the comparison');
    await call('Page.navigate', { url: previewUrl + '?scenario=retired&variant=1&arrival=999' });
    const fallbackRestored = "(() => { const status=document.querySelector('#replay-location-feedback'); return status && !status.hidden && /scenario, variant, arrival/.test(status.textContent) && document.querySelector('#scenario').value==='late' && document.querySelector('#variant').value==='0' && document.querySelector('#arrival').value==='492'; })()";
    for(let i=0;i<60 && !(await evaluate(fallbackRestored));i++) await delay(50);
    assert(await evaluate(fallbackRestored), 'Unsupported URL settings are identified and cannot silently select a different variant');
    await choose('#scenario', 'fresh');
    assert(await evaluate("!document.querySelector('#replay-location-feedback').textContent"));
    await call('Page.navigate', { url: previewUrl + '?scenario=wait&variant=2&arrival=494%0A' });
    const noncanonicalArrival = "(() => {const s=document.querySelector('#replay-location-feedback'); return document.documentElement.dataset.ready==='true' && s.textContent.endsWith('Defaults used for: arrival.') && document.querySelector('#arrival').value==='492' && document.querySelector('#scenario').value==='wait' && document.querySelector('#variant').value==='2';})()";
    for(let i=0;i<60 && !(await evaluate(noncanonicalArrival));i++) await delay(50);
    assert(await evaluate(noncanonicalArrival),'Noncanonical arrival uses the author default without discarding valid neighboring settings');
    await evaluate("document.querySelector('#replay').click()");
    assert(await evaluate("(() => {const params=new URL(location.href).searchParams; return !document.querySelector('#replay-location-feedback').textContent && params.get('arrival')==='492' && params.get('scenario')==='wait' && params.get('variant')==='2';})()"),'Explicit replay commits the visible defaults and dismisses the invalid-link notice');
    await call('Page.navigate', { url: previewUrl + '?scenario=wait&scenario=late&variant=2&arrival=496&arrival=494' });
    for(let i=0;i<60 && !(await evaluate(fallbackRestored));i++) await delay(50);
    assert(await evaluate(fallbackRestored), 'Conflicting duplicate settings do not silently favor the first value');
    const fallbackHook = await call('Page.addScriptToEvaluateOnNewDocument',{source:"Object.defineProperty(window,'ResizeObserver',{value:undefined,configurable:true});"});
    await call('Page.reload',{ignoreCache:true});
    const readyWithoutObserver = "document.documentElement.dataset.ready==='true' && typeof ResizeObserver==='undefined' && !document.querySelector('#export').disabled";
    for(let i=0;i<80 && !(await evaluate(readyWithoutObserver));i++) await delay(50);
    assert(await evaluate(readyWithoutObserver), 'The app works without the optional resize observer');
    await call('Page.removeScriptToEvaluateOnNewDocument',{identifier:fallbackHook.identifier});
    delayAppModule = true;
    await call('Page.reload', { ignoreCache: true });
    const loadingHint = "!!document.querySelector('#startup-loading[role=status]:not([hidden])') && document.querySelector('#replay').disabled";
    for(let i=0;i<40 && !(await evaluate(loadingHint));i++) await delay(50);
    assert(await evaluate(loadingHint),'A slower start shows a polite loading state before any failure');
    const alert = "!!document.querySelector('#startup-loading[role=alert]:not([hidden])') && document.querySelector('#replay').disabled";
    for(let i=0;i<80 && !(await evaluate(alert));i++) await delay(65);
    assert(await evaluate(alert), 'A stalled module shows a useful failure before the browser load event');
    const recovered = "document.documentElement.dataset.ready === 'true' && !document.querySelector('#replay').disabled && document.querySelector('#startup-loading').hidden && !document.querySelector('#report [role=alert]')";
    for(let i=0;i<60 && !(await evaluate(recovered));i++) await delay(60);
    assert(await evaluate(recovered), 'A late successful module can replace the failure and enable controls');
    delayAppModule = false;
    console.log('PASS bonus: stalled module shows guidance, then late successful load recovers');
    await call('Network.enable');
    await call('Network.setBlockedURLs', { urls: ['*/ui/app.js'] });
    await call('Page.reload', { ignoreCache: true });
    for(let i=0;i<60 && !(await evaluate(alert));i++) await delay(50);
    await audit('failed script shows reload guidance before the disabled controls', () => evaluate("(() => {const notice=document.querySelector('#startup-loading'); const controls=document.querySelector('.controls'); return !notice.hidden && /did not load/.test(notice.textContent) && !!(notice.compareDocumentPosition(controls)&Node.DOCUMENT_POSITION_FOLLOWING) && document.querySelector('#replay').disabled && document.querySelector('#export').disabled && document.querySelector('#export-comparison').disabled;})()"));
    await call('Page.navigate',{url:previewUrl+'?scenario=late&variant=0&arrival=492#compare-title'});
    const deepFailure = "(() => {const notice=document.querySelector('#compare-title + #startup-loading[role=alert]'); if(!notice || notice.hidden) return false; const rect=notice.getBoundingClientRect(); return location.hash==='#compare-title' && rect.top>=0 && rect.bottom<=innerHeight && document.querySelector('#export-comparison').disabled;})()";
    for(let i=0;i<60 && !(await evaluate(deepFailure));i++) await delay(50);
    await audit('blocked direct policy link shows recovery within its first viewport', () => evaluate(deepFailure));
    await call('Page.navigate',{url:previewUrl+'?scenario=late&variant=0&arrival=493#report'});
    const directReportFailure = "(() => {const notice=document.querySelector('#report + #startup-loading[role=alert]'); if(!notice || notice.hidden) return false; const rect=notice.getBoundingClientRect(); return location.hash==='#report' && rect.height>0 && rect.top>=0 && rect.bottom<=innerHeight && document.querySelector('#export').disabled;})()";
    for(let i=0;i<60 && !(await evaluate(directReportFailure));i++) await delay(50);
    await audit('blocked direct replay results show how to recover within their first viewport', () => evaluate(directReportFailure));
    await call('Network.setBlockedURLs', { urls: [] });
    const unsupported = await call('Page.addScriptToEvaluateOnNewDocument',{source:"Object.defineProperty(window,'structuredClone',{value:undefined,configurable:true})"});
    await call('Page.navigate',{url:previewUrl+'?arrival=491'});
    const compatibilityHint = "(() => {const notice=document.querySelector('#startup-loading');return typeof structuredClone==='undefined' && notice?.getAttribute('role')==='alert' && /current browser/.test(notice.textContent) && document.querySelector('#export').disabled;})()";
    for(let i=0;i<60 && !(await evaluate(compatibilityHint));i++) await delay(50);
    await audit('unsupported replay feature produces useful browser guidance without enabling exports', () => evaluate(compatibilityHint));
    await call('Page.removeScriptToEvaluateOnNewDocument',{identifier:unsupported.identifier});
    await call('Emulation.setScriptExecutionDisabled', { value: true });
    await call('Page.navigate', { url:previewUrl });
    const noScriptHint = "(() => { const hint = document.querySelector('#noscript-hint'); return /Enable JavaScript/.test(hint?.innerText ?? '') && !!(hint.compareDocumentPosition(document.querySelector('.controls'))&Node.DOCUMENT_POSITION_FOLLOWING) && document.querySelector('#startup-loading').hidden && document.querySelector('#replay').disabled; })()";
    for(let i=0;i<60 && !(await evaluate(noScriptHint));i++) await delay(50);
    assert(await evaluate(noScriptHint), 'When JavaScript is disabled, show its guidance without a perpetual loading message');
    console.log('PASS startup: JavaScript disabled shows only actionable startup guidance');
    await call('Page.navigate',{url:previewUrl+'?arrival=492#compare-title'});
    const directNoScript = "(() => {const local=document.querySelector('#direct-noscript-hint');const regular=document.querySelector('#noscript-hint');if(!local||!regular)return false;const bounds=local.getBoundingClientRect();return /Enable JavaScript/.test(local.textContent) && getComputedStyle(regular).display==='none' && bounds.height>0 && bounds.top>=0 && bounds.bottom<=innerHeight && document.querySelector('#arrival').disabled;})()";
    for(let i=0;i<60 && !(await evaluate(directNoScript));i++) await delay(50);
    await audit('no-script direct comparison shows exactly the relevant notice in its first viewport', () => evaluate(directNoScript));
    await call('Page.navigate',{url:previewUrl+'?scenario=late&variant=0&arrival=492#report'});
    const noScriptReport = "(() => {const local=document.querySelector('#report-noscript-hint');const regular=document.querySelector('#noscript-hint');const comparison=document.querySelector('#direct-noscript-hint');if(!local||!regular||!comparison)return false;const rect=local.getBoundingClientRect();return location.hash==='#report' && /Enable JavaScript/.test(local.textContent) && getComputedStyle(regular).display==='none' && getComputedStyle(comparison).display==='none' && rect.height>0 && rect.top>=0 && rect.bottom<=innerHeight && document.querySelector('#export').disabled;})()";
    for(let i=0;i<60 && !(await evaluate(noScriptReport));i++) await delay(50);
    await audit('no-script direct replay results show only their local guidance', () => evaluate(noScriptReport));
    await call('Emulation.setScriptExecutionDisabled',{value:false});
    await call('Page.navigate',{url:pathToFileURL(resolve(output,'index.html')).href});
    const fileHint = "(() => {const notice=document.querySelector('#startup-loading');return location.protocol==='file:' && notice?.getAttribute('role')==='alert' && /run node scripts\\/preview.mjs/.test(notice.textContent) && document.querySelector('#replay').disabled;})()";
    for(let i=0;i<60 && !(await evaluate(fileHint));i++) await delay(50);
    await audit('direct file startup gives the local web server command rather than asking for a reload', () => evaluate(fileHint));
  }
} finally {
  const stopped = await stopBrowserProcess(child,10000,ws?.readyState===1 ? requestBrowserClose : undefined);
  ws?.close();
  if (server.listening) {
    server.close();
    server.closeAllConnections();
  }
  if (!stopped) {
    console.error('Chromium did not exit after the audit. Its isolated profile was left in test-results.');
    child?.stderr?.destroy();
    child?.unref();
    process.exitCode = 1;
  } else if (scratch && resolve(scratch).startsWith(root + sep) && basename(scratch).startsWith('clockwork-browser-')) {
    try {
      await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    } catch {
      console.error('Could not remove the isolated Chromium profile from test-results.');
      process.exitCode = 1;
    }
  }
}
