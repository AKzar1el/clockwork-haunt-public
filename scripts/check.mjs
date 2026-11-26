import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const flags = process.argv.slice(2);
if (flags.length > 1 || flags.some(flag => flag !== '--engine-only')) {
  console.error('Usage: node scripts/check.mjs [--engine-only]');
  process.exit(2);
}
const engineOnly = flags.includes('--engine-only');
const directory = new URL('../src/tests/', import.meta.url);
const suite = (await readdir(directory, {withFileTypes:true}))
  .filter(entry => entry.isFile() && entry.name.endsWith('.test.ts'))
  .map(entry => 'src/tests/' + entry.name)
  .sort();
if (!suite.length) throw new Error('No engine tests found.');

// Keep ordinary tests on their original per-file limit. CLI contracts spawn
// bounded child processes; the verifier file can start seven of them.
const processContracts = new Set(['src/tests/build-contract.test.ts',
  'src/tests/static-server-contract.test.ts', 'src/tests/verify-evidence.test.ts']);
const ordinary = suite.filter(file => !processContracts.has(file));
const contracts = suite.filter(file => processContracts.has(file));
const testArgs = ['--experimental-strip-types', '--test', '--test-concurrency=1', '--test-reporter=dot'];

for (const [label, args, timeout] of [
  ...(ordinary.length ? [['Engine and evidence tests', [...testArgs, '--test-timeout=30000', ...ordinary]]] : []),
  ...(contracts.length ? [['Subprocess contract tests', [...testArgs, '--test-timeout=240000', ...contracts]]] : []),
  ['Static build', ['build.mjs'], 45000],
  ['Static module graph', ['--experimental-vm-modules', 'scripts/verify-dist.mjs'], 15000],
  ...(engineOnly ? [] : [['Chromium audit', ['scripts/browser-test.mjs', '--audit']]]),
]) {
  console.log('\n' + label);
  const run = spawnSync(process.execPath, args, { cwd:project, stdio:'inherit', windowsHide:true, timeout });
  if (run.error) {
    console.error(label + (run.error.code === 'ETIMEDOUT' ? ' exceeded its time limit.' : ' could not run: ' + run.error.message));
    process.exitCode = 1;
    break;
  }
  if (run.status !== 0) {
    console.error(label + ' did not pass (' + (run.signal ?? 'exit ' + run.status) + ').');
    process.exitCode = run.status ?? 1;
    break;
  }
}
if (engineOnly && !process.exitCode) console.log('Engine, static build and module graph passed. Browser audit not run (--engine-only).');
