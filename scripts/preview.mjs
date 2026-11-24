import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist', import.meta.url));
const port = Number(process.argv[2] ?? '8787');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
await readFile(resolve(root, 'index.html'));
const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  try {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    const type = types[extname(file)];
    if (!file.startsWith(root + sep) || !type) throw new Error('Not found');
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' })
      .end(req.method === 'HEAD' ? undefined : content);
  } catch {
    res.writeHead(404).end('Not found');
  }
});
server.listen(port, '127.0.0.1', () => console.log('Clockwork Haunt: http://127.0.0.1:' + port + '/'));
