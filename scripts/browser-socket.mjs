export function defaultBrowserPaths(platform) {
  switch (platform) {
    case 'win32': return [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ];
    case 'linux': return ['/usr/bin/chromium', '/usr/bin/google-chrome'];
    case 'darwin': return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    default: return [];
  }
}

export function decodeDebuggerPort(content) {
  const matched = /^(\d{1,5})\r?\n/.exec(content);
  const port = matched ? Number(matched[1]) : 0;
  return port > 0 && port <= 65535 ? port : null;
}

export async function readDebuggerPortAttempt(read) {
  try {
    return decodeDebuggerPort(await read());
  } catch (error) {
    // Chromium can temporarily lock its own readiness file while it writes it.
    if (error?.code === 'ENOENT' || error?.code === 'EBUSY') return null;
    throw error;
  }
}

export function fetchWithDeadline(url, options = {}, timeoutMs = 8000) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

function waitForBrowserExit(child, timeoutMs) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise(resolve => {
    const finish = exited => {
      clearTimeout(timer);
      child.removeListener('exit',onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(()=>finish(false),timeoutMs);
    child.once('exit',onExit);
  });
}

export async function stopBrowserProcess(child, timeoutMs = 4000, requestClose, graceMs = 3000) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return true;
  if (requestClose) {
    // A debugger reply can arrive before Chromium finishes closing its profile.
    // Give the real exit event time to arrive before using a process signal.
    Promise.resolve().then(requestClose).catch(() => {});
    if (await waitForBrowserExit(child,graceMs)) return true;
  }
  const exited = waitForBrowserExit(child,timeoutMs);
  if (exited === true) return true;
  try { child.kill(); } catch { /* observe actual exit before touching its profile */ }
  return exited;
}

export async function waitForSocketOpen(socket, timeoutMs = 5000) {
  if (socket.readyState === 1) return;
  if (socket.readyState > 1) throw new Error('Chromium debugger socket closed before opening.');
  await new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      socket.removeEventListener('open', opened);
      socket.removeEventListener('error', failed);
      socket.removeEventListener('close', closed);
      if (error) reject(error);
      else resolve();
    };
    const opened = () => finish();
    const failed = () => finish(new Error('Could not connect to the Chromium debugger socket.'));
    const closed = () => finish(new Error('Chromium debugger socket closed before opening.'));
    const timer = setTimeout(() => finish(new Error('Timed out connecting to the Chromium debugger socket.')), timeoutMs);
    socket.addEventListener('open', opened);
    socket.addEventListener('error', failed);
    socket.addEventListener('close', closed);
  });
}

export function createDebuggerClient(socket, onEvent = () => {}, timeoutMs = 5000) {
  const pending = new Map();
  let nextId = 0;
  let terminalError;
  const finish = (id, error, result) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (error) entry.reject(error);
    else entry.resolve(result);
  };
  const disconnect = message => {
    terminalError ??= new Error(message);
    for (const id of pending.keys()) finish(id, terminalError);
  };
  socket.addEventListener('close', () => disconnect('Chromium debugger connection closed.'));
  socket.addEventListener('error', () => disconnect('Chromium debugger connection failed.'));
  socket.addEventListener('message', ({ data }) => {
    let message;
    try { message = JSON.parse(data); }
    catch { disconnect('Chromium debugger sent an unreadable response.'); return; }
    if (!message || typeof message !== 'object') {
      disconnect('Chromium debugger sent an unreadable response.');
      return;
    }
    if (typeof message.method === 'string') onEvent(message);
    if (message.id !== undefined) {
      finish(message.id, message.error ? new Error(message.error.message) : undefined, message.result);
    }
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    if (terminalError || socket.readyState !== 1) {
      reject(terminalError ?? new Error('Chromium debugger connection is not open.'));
      return;
    }
    const id = ++nextId;
    const timer = setTimeout(() => finish(id, new Error('Browser command timed out: ' + method)), timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { socket.send(JSON.stringify({ id, method, params })); }
    catch (error) { finish(id, error); }
  });
}

