import { lstat, readdir, readFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import * as vm from 'node:vm';
import { staticPolicyTag } from '../build.mjs';

const dist = new URL('../dist/', import.meta.url);
const moduleDirs = new Set(['engine', 'export', 'fixtures', 'ui']);
const staticAssets = new Set(['index.html', 'style.css', 'icon.svg']);
const maxRawBytes = 160 * 1024;
const utf8 = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
// New release output needs explicit review; do not derive this from whatever is on disk.
const expectedOutput = new Set([
  ...staticAssets,
  'engine/classifier.js', 'engine/dedup.js', 'engine/scheduler.js', 'engine/simulator.js',
  'engine/store.js', 'engine/tie-break.js', 'engine/tracer.js', 'engine/types.js',
  'export/evidence.js', 'fixtures/ch01.js', 'fixtures/ch02.js', 'fixtures/ch03.js',
  'fixtures/ch04.js', 'fixtures/policy-comparison.js', 'ui/app.js', 'ui/presentation.js',
]);

export function verifyOutputPaths(paths) {
  const actual = new Set(paths);
  const unexpected = [...actual].filter(path => !expectedOutput.has(path)).sort();
  const missing = [...expectedOutput].filter(path => !actual.has(path)).sort();
  if (unexpected.length) throw new Error('Unexpected released path: ' + unexpected.join(', '));
  if (missing.length) throw new Error('Missing required released path: ' + missing.join(', '));
}

export function verifyStaticBudget(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxRawBytes) {
    throw new Error('Static output exceeds or cannot establish its 160 KiB raw budget.');
  }
}

export function decodeReleasedText(bytes, label) {
  try { return utf8.decode(bytes); }
  catch { throw new Error('Release output is not valid UTF-8: ' + label); }
}

export function verifyStaticPagePolicy(html) {
  const expected = staticPolicyTag(html);
  const offset = html.indexOf(expected);
  const headStart = html.indexOf('<head>');
  const headEnd = html.indexOf('</head>');
  const firstAsset = html.search(/<(?:script|link)\b/i);
  const policies = [...html.matchAll(/\bhttp-equiv\s*=\s*(?:"Content-Security-Policy"|'Content-Security-Policy'|Content-Security-Policy(?=[\s>]))/gi)];
  if (policies.length !== 1 || headStart < 0 || offset <= headStart || offset >= headEnd || offset >= firstAsset) {
    throw new Error('The page must contain one matching static browser policy in the head before asset tags.');
  }
}

async function readReleasedText(url, size, label, files) {
  const bytes = await readFile(url);
  if (bytes.byteLength !== size) throw new Error('Release output changed size while it was being reviewed: ' + label);
  const text = decodeReleasedText(bytes,label);
  files.set(label,bytes);
  return text;
}

export async function verifyModuleGraph(sources) {
  if (!vm.SourceTextModule) throw new Error('Run this check with node --experimental-vm-modules.');
  const label = url => url.startsWith(dist.href) ? url.slice(dist.href.length) : url;
  const modules = new Map();
  for (const [url, content] of sources) {
    try {
      modules.set(url, new vm.SourceTextModule(content, { identifier: url }));
    } catch (error) {
      throw new Error('Cannot parse emitted module ' + label(url) + ': ' + error.message, {cause:error});
    }
  }
  const linker = (name, from) => {
    if (!/^\.{1,2}\//.test(name) || !name.endsWith('.js')) {
      throw new Error('Expected a relative JavaScript module: ' + name + ' (imported by ' + label(from.identifier) + ')');
    }
    const target = modules.get(new URL(name, from.identifier).href);
    if (!target) throw new Error('Missing emitted module: ' + name + ' (imported by ' + label(from.identifier) + ')');
    return target;
  };
  for (const module of modules.values()) {
    if (module.status === 'unlinked') await module.link(linker);
  }
}

export async function verifyDist() {
  const sources = new Map();
  const staticEntries = new Map();
  const outputPaths = [];
  const files = new Map();
  let rawBytes = 0;
  async function accountFor(url) {
    const info = await lstat(url);
    if (!info.isFile()) throw new Error('Release output changed while it was being reviewed.');
    rawBytes += info.size;
    verifyStaticBudget(rawBytes);
    return info.size;
  }
  if (!(await lstat(dist)).isDirectory()) throw new Error('Expected a regular dist directory.');
  for (const entry of await readdir(dist, { withFileTypes: true })) {
    if (entry.isFile() && staticAssets.has(entry.name)) {
      outputPaths.push(entry.name);
      const url = new URL(entry.name,dist);
      staticEntries.set(entry.name, await readReleasedText(url, await accountFor(url), entry.name, files));
      continue;
    }
    if (!entry.isDirectory() || !moduleDirs.has(entry.name)) {
      throw new Error('Unexpected static output: ' + entry.name);
    }
    const dir = new URL(entry.name + '/', dist);
    for (const module of await readdir(dir, { withFileTypes: true })) {
      if (!module.isFile() || !module.name.endsWith('.js')) throw new Error('Unexpected module output: ' + module.name);
      const label = entry.name + '/' + module.name;
      outputPaths.push(label);
      const url = pathToFileURL(resolve(fileURLToPath(dir), module.name));
      const size = await accountFor(url);
      sources.set(url.href, await readReleasedText(url,size,label,files));
    }
  }
  verifyOutputPaths(outputPaths);
  verifyStaticBudget(rawBytes);
  if (staticEntries.size !== staticAssets.size || !sources.has(new URL('ui/app.js', dist).href)) {
    throw new Error('Static output is missing the required page, stylesheet, icon or app entry point.');
  }
  const html = staticEntries.get('index.html');
  verifyStaticPagePolicy(html);
  if (!/<script type="module" src="\.\/ui\/app\.js">/.test(html) ||
      !/<link rel="stylesheet" href="\.\/style\.css">/.test(html) ||
      !/<link rel="icon" type="image\/svg\+xml" href="\.\/icon\.svg">/.test(html)) {
    throw new Error('The page does not reference the emitted module, stylesheet and icon.');
  }
  await verifyModuleGraph(sources);
  return { modules: sources.size, assets: staticEntries.size, paths: outputPaths.sort(), rawBytes, files };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 2) {
    console.error('Usage: node --experimental-vm-modules scripts/verify-dist.mjs\nChecks this checkout\'s dist directory; no path argument is accepted.');
    process.exit(2);
  }
  try {
    const { modules, assets, rawBytes } = await verifyDist();
    console.log('Verified static release graph: ' + modules + ' linked modules, ' + assets +
      ' page assets and ' + rawBytes + ' total raw bytes.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
