import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { decodeBuildText, emitBrowserModule, emitStaticHtml, normalizeWebText, selectBrowserSources, verifyBuilt } from '../../build.mjs';
import { decodeReleasedText, verifyStaticBudget, verifyStaticPagePolicy } from '../../scripts/verify-dist.mjs';
import { POLICY_ARRIVAL } from '../fixtures/policy-comparison.ts';
import { formatReplayMinute } from '../ui/presentation.ts';

test('emitted graph errors name the broken file or the exact importing module', () => {
  const script = `
    import assert from 'node:assert/strict';
    import {verifyModuleGraph} from ${JSON.stringify(new URL('../../scripts/verify-dist.mjs',import.meta.url).href)};
    const entry = ${JSON.stringify(new URL('../../dist/ui/app.js',import.meta.url).href)};
    const child = ${JSON.stringify(new URL('../../dist/fixtures/example.js',import.meta.url).href)};
    const graph = source => new Map([[entry,"import '../fixtures/example.js';"],[child,source]]);
    await assert.rejects(verifyModuleGraph(graph("import './missing.js';")), {
      message:'Missing emitted module: ./missing.js (imported by fixtures/example.js)',
    });
    await assert.rejects(verifyModuleGraph(graph("import 'example';")), {
      message:'Expected a relative JavaScript module: example (imported by fixtures/example.js)',
    });
    await assert.rejects(verifyModuleGraph(graph("export const = ;")), error =>
      error.message.startsWith('Cannot parse emitted module fixtures/example.js:') && error.cause instanceof SyntaxError);
    await verifyModuleGraph(graph("export const ready = true;"));
  `;
  const run = spawnSync(process.execPath,['--experimental-vm-modules','--input-type=module','-'],{
    input:script,encoding:'utf8',timeout:30000,windowsHide:true,
  });
  assert.ifError(run.error);
  assert.equal(run.status,0,run.stderr);
});

test('disabled startup controls reflect the initial policy range before scripts load', async () => {
  const html = await readFile(new URL('../ui/index.html',import.meta.url),'utf8');
  const slider = html.match(/<input\b[^>]*\bid="arrival"[^>]*>/)?.[0];
  assert(slider);
  for (const [name,value] of Object.entries({
    min:POLICY_ARRIVAL.min,max:POLICY_ARRIVAL.max,value:POLICY_ARRIVAL.initial,step:1,
  })) {
    assert(slider.includes(' '+name+'="'+value+'"'), 'Startup slider attribute '+name);
  }
  assert.match(slider,/\bdisabled\b/);
  assert.equal(html.match(/<span id="arrival-time"[^>]*>([^<]*)<\/span>/)?.[1],
    formatReplayMinute(POLICY_ARRIVAL.initial));
  assert.match(slider,/aria-describedby="arrival-range"/);
  assert.equal(html.match(/<span id="arrival-range"[^>]*>([^<]*)<\/span>/)?.[1],
    formatReplayMinute(POLICY_ARRIVAL.min)+' to '+formatReplayMinute(POLICY_ARRIVAL.max));
});

test('build input rejects invalid UTF-8 and preserves valid Unicode', () => {
  assert.throws(() => decodeBuildText(Buffer.from([0xc3,0x28]), 'sample.ts'), /not valid UTF-8: sample.ts/);
  assert.equal(decodeBuildText(Buffer.from([0xef,0xbb,0xbf,0xc5,0xa0]), 'sample.ts'), '\uFEFF\u0160');
});

test('a browser module compilation error names the source file and preserves the underlying diagnostic', () => {
  for (const [label,source] of [
    ['src/fixtures/broken-example.ts','export const = ;'],
    ['src/ui/unsupported-example.ts','enum Mode { Replay }; export { Mode };'],
  ] as const) {
    assert.throws(()=>emitBrowserModule(source,label), (error:unknown) => {
      assert(error instanceof Error);
      assert(error.message.startsWith('Cannot emit browser module ' + label + ': '));
      assert(error.cause instanceof Error);
      assert(error.message.includes(error.cause.message));
      return true;
    });
  }
});

test('static release budget accepts its inclusive limit and rejects an extra byte', () => {
  assert.doesNotThrow(()=>verifyStaticBudget(160*1024));
  assert.throws(()=>verifyStaticBudget(160*1024+1),/160 KiB raw budget/);
});

test('standalone release verification does not silently replace damaged text in shipped assets', () => {
  assert.throws(() => decodeReleasedText(Buffer.from([0xef,0xbb,0xbf,0xc5,0x28]),'icon.svg'),
    /not valid UTF-8: icon\.svg/);
  assert.equal(decodeReleasedText(Buffer.from([0xef,0xbb,0xbf,0xc5,0xa0]),'ui/app.js'),'\uFEFF\u0160');
});

test('source parity never fills gaps in an explicit verified output snapshot from disk', async () => {
  await assert.rejects(()=>verifyBuilt(new Map()),/Static output is stale or missing:/);
});

test('the emitted HTML policy covers the exact reviewed bootstrap and module', async () => {
  const html = await readFile(new URL('../ui/index.html',import.meta.url),'utf8');
  const built = emitStaticHtml(html);
  assert.equal(emitStaticHtml(html.replace(/\r?\n/g,'\r\n')),built);
  assert.match(built,/http-equiv="Content-Security-Policy".*script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
  assert.match(built,/connect-src 'none'/);
  assert.doesNotMatch(built,/CLOCKWORK_STATIC_POLICY|unsafe-inline/);
  assert.throws(()=>emitStaticHtml(html.replace('</body>','<script></script></body>')),/exactly the reviewed/);
});

test('standalone release verification rejects a stale, duplicate or late policy', async () => {
  const source = await readFile(new URL('../ui/index.html',import.meta.url),'utf8');
  const html = emitStaticHtml(source);
  const policy = html.match(/<meta http-equiv="Content-Security-Policy"[^>]*>/)?.[0];
  assert(policy);
  assert.doesNotThrow(()=>verifyStaticPagePolicy(html));
  assert.throws(()=>verifyStaticPagePolicy(html.replace('The simulator did not load','The simulator could not load')),/one matching static browser policy/);
  assert.throws(()=>verifyStaticPagePolicy(html.replace(policy,policy+'\n'+policy)),/one matching static browser policy/);
  assert.throws(()=>verifyStaticPagePolicy(html.replace(policy,'').replace('</head>',policy+'</head>')),/one matching static browser policy/);
});

test('browser text outputs do not depend on checkout CRLF conversion', () => {
  const lf = "export const title: string = 'demo';\n";
  assert.equal(emitBrowserModule(lf.replace(/\n/g,'\r\n')),emitBrowserModule(lf));
  assert.equal(normalizeWebText('\uFEFF<html>\r\n</html>\n'),'\uFEFF<html>\n</html>\n');
});

test('the ordinary build rejects ambiguous source names or non-regular entries before emission', () => {
  const entry = (name: string, regular = true) => ({name,isFile:()=>regular});
  assert.deepEqual(selectBrowserSources([entry('app.ts'),entry('index.html'),entry('style.css'),entry('icon.svg'),entry('other-module4.ts')],'ui')
    .map(item=>item.name),['app.ts','other-module4.ts']);
  for (const rejected of [entry('test source.ts'),entry('different#source.ts'),entry('extra.ts\n'),entry('extra.ts',false),entry('extras',false)]) {
    assert.throws(()=>selectBrowserSources([rejected],'engine'),/Unsupported browser source entry/);
  }
  assert.throws(()=>selectBrowserSources([entry('index.html',false)],'ui'),/Unsupported browser source entry/);
});

test('the builder refuses a clean but incomplete browser input package', () => {
  const entry = (name: string)=>({name,isFile:()=>true});
  const ui = ['app.ts','index.html','style.css','icon.svg'].map(entry);
  assert.throws(()=>selectBrowserSources(ui.slice(1),'ui'),/Missing required browser source: ui\/app\.ts/);
  assert.throws(()=>selectBrowserSources(ui.slice(0,3),'ui'),/Missing required browser source: ui\/icon\.svg/);
  assert.throws(()=>selectBrowserSources([],'engine'),/No browser modules found in src\/engine/);
});

test('build rewrites static imports and re-exports without modifying ordinary prose', () => {
  const built = emitBrowserModule([
    "import './setup.ts';",
    "import {",
    "  entry,",
    "} from './module.ts';",
    "import type { Entry } from './types.ts';",
    "export { entry } from '../loader.ts';",
    "const label = \"display from './example.ts'\";",
  ].join('\n'));
  assert.match(built, /import '\.\/setup\.js'/);
  assert.match(built, /} from '\.\/module\.js'/);
  assert.match(built, /from '\.\.\/loader\.js'/);
  assert.doesNotMatch(built, /types\.ts/);
  assert.match(built, /display from '\.\/example\.ts'/);
});
