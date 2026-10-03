const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

async function main() {
  const root = path.resolve(__dirname, '..');
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'bilinote-sync-build-'));
  const inputs = ['src/main.js', 'src/styles.css', 'manifest.json', 'scripts/prepare-release.cjs'];
  for (const file of inputs) {
    const destination = path.join(fixture, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(root, file), destination);
  }
  await assert.rejects(fs.access(path.join(fixture, 'main.js')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(fixture, 'styles.css')), { code: 'ENOENT' });
  const manifest = JSON.parse(await fs.readFile(path.join(fixture, 'manifest.json'), 'utf8'));
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = spawnSync(process.execPath, ['scripts/prepare-release.cjs'], {
      cwd: fixture, encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, 0, 'clean build must recreate missing installation assets: ' + result.stderr);
    for (const file of ['main.js', 'manifest.json', 'styles.css']) {
      const input = path.join(root, file === 'manifest.json' ? file : 'src/' + file);
      const expected = await fs.readFile(input);
      assert.deepEqual(await fs.readFile(path.join(fixture, file)), expected, 'root asset matches source: ' + file);
      assert.deepEqual(await fs.readFile(path.join(fixture, '.release', manifest.version, file)), expected, 'release asset matches source: ' + file);
    }
  }
  console.log('PASS: clean build recreates missing main.js/styles.css from source, produces exact release assets, and is repeatable.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
