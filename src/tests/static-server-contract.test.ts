import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createStaticServer, hasPreviewIndex } from '../../scripts/static-server.mjs';

test('standalone browser audit names a missing build before launching a browser', async () => {
  const scratch = resolve('test-results');
  await mkdir(scratch, {recursive:true});
  const root = await mkdtemp(join(scratch,'browser-no-build-'));
  try {
    await mkdir(join(root,'scripts'));
    for (const name of ['browser-test.mjs','browser-socket.mjs','static-server.mjs','preview.mjs']) {
      await copyFile(new URL('../../scripts/'+name,import.meta.url),join(root,'scripts',name));
    }
    for (const flags of [[],['--audit']]) {
      const result = spawnSync(process.execPath,[join(root,'scripts','browser-test.mjs'),...flags],{
        // Run from the actual checkout, where a build can exist. The copied
        // harness must inspect its own location, not the caller's cwd.
        encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env,CHROME_BIN:'intentionally-not-a-browser'},
      });
      assert.ifError(result.error);
      assert.equal(result.status,1);
      assert.match(result.stderr,/No static build found.*node build\.mjs/);
    }
    const preview = (...args: string[]) => spawnSync(process.execPath,[join(root,'scripts','preview.mjs'),...args],
      {encoding:'utf8',windowsHide:true,timeout:30000});
    const help = preview('--help');
    assert.ifError(help.error);
    assert.equal(help.status,0);
    assert.equal(help.stderr,'');
    assert.match(help.stdout,/^Usage:.*\n.*127\.0\.0\.1:8787.*port 0.*loopback port\..*\n.*node build\.mjs/);
    const invalid = preview('--help','0');
    assert.ifError(invalid.error);
    assert.equal(invalid.status,2);
    assert.match(invalid.stderr,/^Usage:/);
    assert.deepEqual(await readdir(root),['scripts'],'help and missing build must not create work directories');
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test('preview starts only with a regular index file, checked without opening its body', async () => {
  const scratch = resolve('test-results');
  await mkdir(scratch, { recursive:true });
  const root = await mkdtemp(join(scratch,'static-index-'));
  try {
    const index = join(root,'index.html');
    assert.equal(await hasPreviewIndex(root),false);
    await mkdir(index);
    assert.equal(await hasPreviewIndex(root),false);
    await rm(index,{recursive:true});
    await writeFile(index,'<!doctype html>');
    assert.equal(await hasPreviewIndex(root),true);
    assert.equal(await hasPreviewIndex(index),false);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});

test('loopback preview serves matching GET and HEAD metadata without caching', async () => {
  const scratch = resolve('test-results');
  await mkdir(scratch, { recursive:true });
  const root = await mkdtemp(join(scratch,'static-contract-'));
  const server = createStaticServer(root, { mount:'/demo/' });
  try {
    const html = '<title>Clockwork Haunt \u2014 preview</title>';
    await writeFile(join(root,'index.html'),html);
    await writeFile(join(root,'app.js'),'export const ready = true;');
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    const address = server.address();
    assert(address && typeof address === 'object');
    const base = 'http://127.0.0.1:' + address.port;
    const short = '/demo?scenario=late&variant=1&arrival=494';
    for (const method of ['GET', 'HEAD']) {
      const canonical = await fetch(base+short,{method,redirect:'manual'});
      assert.equal(canonical.status,308);
      assert.equal(canonical.headers.get('location'),'/demo/?scenario=late&variant=1&arrival=494');
      assert.equal(canonical.headers.get('cache-control'),'no-store');
      assert.equal(await canonical.text(),'');
    }
    const neighbor = await fetch(base+'/demo-other');
    assert.equal(neighbor.status,404);
    await neighbor.text();
    for (const [path, mime, body] of [
      ['/demo/','text/html; charset=utf-8',html],
      ['/demo/app.js','text/javascript; charset=utf-8','export const ready = true;'],
    ]) {
      const get = await fetch(base+path);
      const head = await fetch(base+path,{method:'HEAD'});
      for (const response of [get,head]) {
        assert.equal(response.status,200);
        assert.equal(response.headers.get('content-type'),mime);
        assert.equal(response.headers.get('content-length'),String(Buffer.byteLength(body)));
        assert.equal(response.headers.get('cache-control'),'no-store');
        assert.equal(response.headers.get('x-content-type-options'),'nosniff');
        assert.equal(response.headers.get('set-cookie'),null);
      }
      assert.equal(await get.text(),body);
      assert.equal(await head.text(),'');
    }
    await mkdir(join(root,'directory.js'));
    for (const path of ['/demo/missing.js','/demo/app.js/','/demo/index.html/','/demo/directory.js']) {
      for (const method of ['GET','HEAD']) {
        const missing = await fetch(base+path,{method});
        assert.equal(missing.status,404,method+' '+path);
        assert.equal(await missing.text(),method === 'HEAD' ? '' : 'Not found');
      }
    }
    const post = await fetch(base+'/demo/',{method:'POST'});
    assert.equal(post.status,405);
    assert.equal(post.headers.get('allow'),'GET, HEAD');
    await post.text();
  } finally {
    if (server.listening) await new Promise<void>((resolve,reject) =>
      server.close(error => error ? reject(error) : resolve()));
    await rm(root,{recursive:true,force:true});
  }
});
