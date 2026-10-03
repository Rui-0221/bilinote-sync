const fs = require('node:fs/promises');
const path = require('node:path');
async function main() {
  const root = path.resolve(__dirname, '..');
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid version');
  const output = path.join(root, '.release', manifest.version);
  await fs.mkdir(output, { recursive: true });
  for (const file of ['main.js', 'manifest.json', 'styles.css']) await fs.copyFile(path.join(root, file), path.join(output, file));
  console.log('Prepared three individual release assets for ' + manifest.version);
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
