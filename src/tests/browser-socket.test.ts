import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createDebuggerClient, decodeDebuggerPort, defaultBrowserPaths, fetchWithDeadline, readDebuggerPortAttempt, stopBrowserProcess, waitForSocketOpen } from '../../scripts/browser-socket.mjs';

class Socket extends EventTarget {
  readyState = 0;
  outgoing: string[] = [];
  send(message: string) { this.outgoing.push(message); }
  respond(message: object) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }
}

test('browser discovery includes ordinary application bundles on macOS without probing other platforms', () => {
  const mac = defaultBrowserPaths('darwin');
  const chromium = '/Applications/Chromium.app/Contents/MacOS/Chromium';
  assert.equal(mac[0], '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  assert.equal(mac.find(path => path === chromium), chromium);
  assert(mac.every(path => path.startsWith('/Applications/') && path.includes('.app/Contents/MacOS/')));
  assert(defaultBrowserPaths('win32').some(path=>path.endsWith('/chrome.exe')));
  assert(defaultBrowserPaths('linux').includes('/usr/bin/chromium'));
  assert.deepEqual(defaultBrowserPaths('unsupported'),[]);
});

test('debugger port file requires a complete nonzero line in range', () => {
  for (const candidate of ['', '42', '-1\n', '0\n', '65536\n', '12abc\n']) {
    assert.equal(decodeDebuggerPort(candidate), null);
  }
  assert.equal(decodeDebuggerPort('65535\r\n/devtools/browser/local'), 65535);
});

test('temporary debugger port file locks and absence are retried, while denial is not', async () => {
  const readFailure = (code: string) => () => Promise.reject(Object.assign(new Error(code),{code}));
  assert.equal(await readDebuggerPortAttempt(readFailure('EBUSY')),null);
  assert.equal(await readDebuggerPortAttempt(readFailure('ENOENT')),null);
  await assert.rejects(readDebuggerPortAttempt(readFailure('EACCES')),{code:'EACCES'});
  assert.equal(await readDebuggerPortAttempt(()=>Promise.resolve('9000\n')),9000);
});

test('browser socket handles open, startup failure, closing and a stalled handshake', async () => {
  const open = new Socket();
  const ready = waitForSocketOpen(open);
  open.dispatchEvent(new Event('open'));
  await ready;
  const closed = new Socket();
  const closing = waitForSocketOpen(closed);
  closed.dispatchEvent(new Event('close'));
  await assert.rejects(closing, /closed before opening/);
  const broken = new Socket();
  const failing = waitForSocketOpen(broken);
  broken.dispatchEvent(new Event('error'));
  await assert.rejects(failing, /Could not connect/);
  await assert.rejects(waitForSocketOpen(new Socket(), 15), /Timed out connecting/);
});

test('browser client correlates replies and promptly rejects requests on disconnect', async () => {
  const socket = new Socket();
  socket.readyState = 1;
  const events: string[] = [];
  const call = createDebuggerClient(socket, (event: {method:string}) => events.push(event.method));
  const received = call('Test.reply');
  const outstanding = call('Test.pending');
  socket.respond({ method:'Test.event' });
  socket.respond({ id:JSON.parse(socket.outgoing[0]).id, result:{ok:true} });
  assert.deepEqual(await received, {ok:true});
  assert.deepEqual(events, ['Test.event']);
  socket.dispatchEvent(new Event('close'));
  await assert.rejects(outstanding, /connection closed/);
  await assert.rejects(call('Test.later'), /connection closed/);
});

test('loopback verification fetch aborts if the preview server never responds', async () => {
  const server = createServer(() => {});
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    await assert.rejects(fetchWithDeadline('http://127.0.0.1:' + address.port + '/',{},50), {name:'TimeoutError'});
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('the isolated process is stopped before the test runner releases its profile', async () => {
  const child = spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],{stdio:'ignore',windowsHide:true});
  assert.equal(await stopBrowserProcess(child), true);
  assert(child.exitCode !== null || child.signalCode !== null);
});

test('a graceful debugger reply waits for actual exit without killing a healthy child', async () => {
  const child = Object.assign(new EventEmitter(),{pid:1,exitCode:null as number|null,signalCode:null,
    kill(){ assert.fail('Kill while graceful exit is pending'); }});
  const closed = stopBrowserProcess(child,100,async () => {
    setImmediate(()=>{child.exitCode=0;child.emit('exit',0,null);});
  },100);
  assert.equal(await closed,true);
});

test('a transient signal error is not mistaken for proof that the process failed to exit', async () => {
  const child = Object.assign(new EventEmitter(),{pid:1,exitCode:null as number|null,signalCode:null,
    kill(){ this.emit('error',new Error('synthetic transient signal report')); setImmediate(()=>{
      this.exitCode=0;this.emit('exit',0,null);
    }); }});
  child.on('error',()=>{});
  assert.equal(await stopBrowserProcess(child,100),true);
  assert.equal(child.exitCode,0);
});

test('a non-exiting audit child cannot block cleanup or leave exit listeners attached', async () => {
  let signals = 0;
  let gracefulRequests = 0;
  const child = Object.assign(new EventEmitter(),{pid:1,exitCode:null,signalCode:null,
    kill(){ signals++; return false; }});
  const observed = await stopBrowserProcess(child,15,() => {
    gracefulRequests++;
    return new Promise(() => {});
  },15);
  assert.equal(observed,false);
  assert.equal(gracefulRequests,1);
  assert.equal(signals,1);
  assert.equal(child.listenerCount('exit'),0);
});
