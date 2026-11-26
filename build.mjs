import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const dir = (relative) => new URL(relative, import.meta.url);
const modules = ['engine', 'export', 'fixtures', 'ui'];
const assets = ['index.html', 'style.css', 'icon.svg'];
const utf8 = new TextDecoder('utf-8', { fatal:true, ignoreBOM:true });

export function decodeBuildText(bytes, label) {
  try { return utf8.decode(bytes); }
  catch { throw new Error('Build source is not valid UTF-8: ' + label); }
}

export function normalizeWebText(text) {
  return text.replace(/\r\n/g,'\n');
}

export function staticPolicyTag(html) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  if (scripts.length !== 2 || scripts[0][1].trim() ||
      scripts[1][1].trim() !== 'type="module" src="./ui/app.js"' || scripts[1][2].trim()) {
    throw new Error('Static page must contain exactly the reviewed bootstrap and app module scripts.');
  }
  const hash = createHash('sha256').update(scripts[0][2].replace(/\r\n?/g,'\n')).digest('base64');
  return '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\' \'sha256-' + hash +
    '\'; style-src \'self\'; img-src \'self\'; connect-src \'none\'; base-uri \'none\'; form-action \'none\'; object-src \'none\'">';
}

export function emitStaticHtml(source) {
  const text = source.replace(/\r\n?/g,'\n');
  const marker = '<!-- CLOCKWORK_STATIC_POLICY -->';
  const firstAsset = text.search(/<(?:link|script)\b/i);
  const headStart = text.indexOf('<head>');
  const headEnd = text.indexOf('</head>');
  const offset = text.indexOf(marker);
  if (offset <= headStart || offset >= headEnd || offset >= firstAsset ||
      offset !== text.lastIndexOf(marker) || /http-equiv\s*=\s*["']Content-Security-Policy/i.test(text) || text.includes('\0')) {
    throw new Error('Expected one static policy marker in the head before any asset.');
  }
  return text.replace(marker,staticPolicyTag(text));
}

export function emitBrowserModule(source, label = 'input') {
  let javascript;
  try {
    javascript = stripTypeScriptTypes(normalizeWebText(source), { mode:'strip' });
  } catch (error) {
    throw new Error('Cannot emit browser module ' + label + ': ' + error.message, {cause:error});
  }
  return javascript
    // The browser tree uses static relative module declarations. Anchor the
    // rewrite so prose and normal string values mentioning a .ts path stay intact.
    .replace(/^([ \t]*(?:(?:import|export)\b[^\r\n]*?|\})[ \t]+from[ \t]+['"]\.{1,2}\/[^'"\r\n]+)\.ts(['"])/gm, '$1.js$2')
    .replace(/^([ \t]*import[ \t]+['"]\.{1,2}\/[^'"\r\n]+)\.ts(['"])/gm, '$1.js$2');
}

async function existingEntries(directory) {
  try {
    if (!(await lstat(directory)).isDirectory()) {
      throw new Error(fileURLToPath(directory) + ' must be a real build directory.');
    }
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return [];
  }
}

export function selectBrowserSources(entries, directory) {
  const sources = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.ts') && /^[a-z][a-z0-9-]*\.ts$/.test(entry.name)) {
      sources.push(entry);
    } else if (directory !== 'ui' || !entry.isFile() || !assets.includes(entry.name)) {
      throw new Error('Unsupported browser source entry: ' + directory + '/' + entry.name +
        '. Expected a regular .ts file with lowercase letters, numbers or hyphens in its name.');
    }
  }
  if (directory === 'ui') {
    const missing = ['app.ts',...assets].filter(required=>!entries.some(entry=>entry.name===required));
    if (missing.length) throw new Error('Missing required browser source: ' + missing.map(name=>'ui/'+name).join(', '));
  }
  if (!sources.length) throw new Error('No browser modules found in src/' + directory + '.');
  return sources;
}

async function planBuild() {
  const extras = (await existingEntries(dir('./dist/'))).filter(entry =>
    !(modules.includes(entry.name) && entry.isDirectory()) && !(assets.includes(entry.name) && entry.isFile()));
  if (extras.length) {
    throw new Error('Unexpected generated output in dist: ' +
      extras.map(entry => entry.name).join(', ') + '. Move the unexpected files aside before rebuilding.');
  }

  const buildPlan = [];
  for (const name of modules) {
    const source = dir('./src/' + name + '/');
    const output = dir('./dist/' + name + '/');
    const sources = selectBrowserSources(await readdir(source, { withFileTypes: true }),name);
    const expected = new Set(sources.map(file => file.name.replace(/\.ts$/, '.js')));
    const previous = await existingEntries(output);
    const stale = previous.filter(file => !file.isFile() || !expected.has(file.name));
    if (stale.length) {
      throw new Error('Unexpected generated output in dist/' + name + ': ' +
        stale.map(file => file.name).join(', ') + '. Move the unexpected files aside before rebuilding.');
    }
    buildPlan.push({ source, output, sources });
  }
  // Validate every input before touching any previously built file. This keeps
  // a mistyped source module from leaving a mixed-version preview on disk.
  const writes = [];
  for (const { source, output, sources } of buildPlan) {
    for (const file of sources) {
      const sourceUrl = new URL(file.name, source);
      const sourcePath = sourceUrl.href.slice(dir('./').href.length);
      const sourceText = decodeBuildText(await readFile(sourceUrl), sourcePath);
      const js = emitBrowserModule(sourceText, sourcePath);
      writes.push([new URL(file.name.replace(/\.ts$/, '.js'), output), js, sourcePath]);
    }
  }
  for (const file of assets) {
    const sourcePath = 'src/ui/' + file;
    const bytes = await readFile(dir('./' + sourcePath));
    const decoded = decodeBuildText(bytes, sourcePath);
    const text = file === 'index.html' ? emitStaticHtml(decoded) : normalizeWebText(decoded);
    writes.push([dir('./dist/' + file), text, sourcePath]);
  }
  return { buildPlan, writes };
}

export async function verifyBuilt(outputFiles) {
  const { writes } = await planBuild();
  for (const [destination, content] of writes) {
    const emitted = destination.href.substring(dir('./dist/').href.length);
    const expected = typeof content === 'string' ? Buffer.from(content) : content;
    const actual = outputFiles ? outputFiles.get(emitted) : await readFile(destination).catch(error => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!actual?.equals(expected)) {
      throw new Error('Static output is stale or missing: ' + emitted + '. Run node build.mjs.');
    }
  }
  return writes.map(([, , sourcePath]) => sourcePath);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const flags = process.argv.slice(2);
  if (flags.length === 0) {
    const { buildPlan, writes } = await planBuild();
    for (const { output } of buildPlan) await mkdir(output, { recursive: true });
    for (const [destination, content] of writes) await writeFile(destination, content);
    console.log('Static build ready: ' + fileURLToPath(dir('./dist/index.html')));
  } else if (flags.length === 1 && flags[0] === '--verify') {
    await verifyBuilt();
    console.log('Static output matches current source bytes.');
  } else {
    console.error('Usage: node build.mjs [--verify]');
    process.exitCode = 2;
  }
}
