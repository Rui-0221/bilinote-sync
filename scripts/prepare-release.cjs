const fs = require('node:fs/promises');
const path = require('node:path');
async function main() {
  const root = path.resolve(__dirname, '..');
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid version');
  // Reviewers remove generated installation assets before running the build.
  // Recreate them from tracked source instead of using the outputs as inputs.
  // Source names differ from release assets: a recursive clean must not remove
  // the build inputs along with all copies of main.js and styles.css.
  for (const [input, output] of [['plugin.cjs', 'main.js'], ['plugin.css', 'styles.css']]) {
    await fs.copyFile(path.join(root, 'src', input), path.join(root, output));
  }
  const output = path.join(root, '.release', manifest.version);
  await fs.mkdir(output, { recursive: true });
  for (const file of ['main.js', 'manifest.json', 'styles.css']) await fs.copyFile(path.join(root, file), path.join(output, file));
  console.log('Prepared three individual release assets for ' + manifest.version);
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
