import { fileURLToPath } from 'node:url';
import { createStaticServer, hasPreviewIndex } from './static-server.mjs';

const root = fileURLToPath(new URL('../dist', import.meta.url));
const usage = 'Usage: node scripts/preview.mjs [port]';
if (process.argv.length === 3 && process.argv[2] === '--help') {
  console.log(usage);
  console.log('Default: http://127.0.0.1:8787/. Use port 0 to choose an available loopback port.');
  console.log('Run node build.mjs first if the static build is missing.');
  process.exit(0);
}
const portText = process.argv[2] ?? '8787';
const port = Number(portText);
if (!/^\d{1,5}$/.test(portText) || port > 65535 || process.argv.length > 3) {
  console.error(usage + '\nPort must be an integer from 0 to 65535.');
  process.exit(2);
}
if (!(await hasPreviewIndex(root))) {
  console.error('No static build found. Run node build.mjs before starting the preview.');
  process.exit(1);
}
const server = createStaticServer(root);
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE'
    ? 'Preview port ' + port + ' is in use. Run node scripts/preview.mjs 0 to choose an open loopback port.'
    : 'Preview server could not start: ' + error.message);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => console.log('Clockwork Haunt: http://127.0.0.1:' + server.address().port + '/'));
