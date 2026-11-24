import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const dir = (relative) => new URL(relative, import.meta.url);
for (const name of ['engine', 'export', 'fixtures', 'ui']) {
  const source = dir('./src/' + name + '/');
  const output = dir('./dist/' + name + '/');
  await mkdir(output, { recursive: true });
  for (const file of await readdir(source, { withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith('.ts')) continue;
    const sourceText = await readFile(new URL(file.name, source), 'utf8');
    const js = stripTypeScriptTypes(sourceText, { mode: 'strip' })
      .replace(/(\bfrom\s+['"]\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1.js$2');
    await writeFile(new URL(file.name.replace(/\.ts$/, '.js'), output), js);
  }
}
for (const file of ['index.html', 'style.css']) {
  await copyFile(dir('./src/ui/' + file), dir('./dist/' + file));
}
console.log('Static build ready: ' + fileURLToPath(dir('./dist/index.html')));
