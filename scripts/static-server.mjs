import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';

const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
]);

export async function hasPreviewIndex(directory) {
  try {
    return (await stat(resolve(directory,'index.html'))).isFile();
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

/** Shared request handler for the loopback preview and actual browser QA. */
export function createStaticServer(directory, { beforeRead, mount = '/' } = {}) {
  const root = resolve(directory);
  if (!/^\/(?:[a-z0-9_-]+\/)*$/i.test(mount)) throw new Error('Invalid preview mount path.');
  const shortMount = mount === '/' ? null : mount.slice(0,-1);
  return createServer(async (req, res) => {
    const notFound = () => res.writeHead(404).end('Not found');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    try {
      const { pathname, search } = new URL(req.url, 'http://127.0.0.1');
      if (pathname === shortMount) {
        // Relative page assets must resolve inside the mounted directory.
        res.writeHead(308, { Location: mount + search, 'Cache-Control': 'no-store' }).end();
        return;
      }
      if (!pathname.startsWith(mount)) { notFound(); return; }
      const mountedPath = '/' + pathname.slice(mount.length);
      // Only the mounted root has an index route. Path resolution would
      // otherwise turn a mistaken directory-style URL into an asset URL.
      if (mountedPath !== '/' && mountedPath.endsWith('/')) { notFound(); return; }
      const name = mountedPath === '/' ? '/index.html' : mountedPath;
      const file = resolve(root, '.' + name);
      const type = types.get(extname(file));
      if (!file.startsWith(root + sep) || !type) { notFound(); return; }
      await beforeRead?.(name);
      const [assetRoot, assetFile] = await Promise.all([realpath(root), realpath(file)]);
      const withinRoot = relative(assetRoot, assetFile);
      if (!withinRoot || isAbsolute(withinRoot) || withinRoot === '..' || withinRoot.startsWith('..' + sep)) {
        notFound();
        return;
      }
      const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      const asset = await stat(assetFile);
      if (!asset.isFile()) { notFound(); return; }
      if (req.method === 'HEAD') {
        res.writeHead(200, { ...headers, 'Content-Length': asset.size }).end();
        return;
      }
      const content = await readFile(assetFile);
      res.writeHead(200, { ...headers, 'Content-Length': content.length }).end(content);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'EISDIR') notFound();
      else res.writeHead(500).end('Preview asset could not be read');
    }
  });
}
