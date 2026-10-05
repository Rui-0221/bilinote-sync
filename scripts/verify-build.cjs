const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

async function main() {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'bilinote-sync-build-'));
  const legacy = process.argv[2];
  const sources = legacy ? { 'main.js': 'src/main.js', 'styles.css': 'src/styles.css' }
    : { 'main.js': 'src/plugin.cjs', 'styles.css': 'src/plugin.css' };
  const inputs = [...Object.values(sources), 'manifest.json', 'scripts/prepare-release.cjs', 'main.js', 'styles.css'];
  for (const file of inputs) {
    const destination = path.join(fixture, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(root, file), destination);
  }
  const manifest = JSON.parse(await fs.readFile(path.join(fixture, 'manifest.json'), 'utf8'));
  for (let attempt = 0; attempt < 2; attempt++) {
    // Reproduce a reviewer cleaning asset filenames throughout the checkout,
    // including nested source/release directories. Only synthetic files move.
    for (const entry of await fs.readdir(fixture, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !['main.js', 'styles.css'].includes(entry.name)) continue;
      const target = path.resolve(entry.parentPath || entry.path, entry.name);
      assert.ok(target.startsWith(fixture + path.sep), 'clean target stays inside the isolated fixture');
      await fs.unlink(target);
    }
    await assert.rejects(fs.access(path.join(fixture, 'main.js')), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(fixture, 'styles.css')), { code: 'ENOENT' });
    const result = spawnSync(process.execPath, ['scripts/prepare-release.cjs'], {
      cwd: fixture, encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, 0, 'clean build must recreate missing installation assets: ' + result.stderr);
    for (const file of ['main.js', 'manifest.json', 'styles.css']) {
      const input = path.join(root, file === 'manifest.json' ? file : sources[file]);
      const expected = await fs.readFile(input);
      assert.deepEqual(await fs.readFile(path.join(fixture, file)), expected, 'root asset matches source: ' + file);
      assert.deepEqual(await fs.readFile(path.join(fixture, '.release', manifest.version, file)), expected, 'release asset matches source: ' + file);
    }
  }
  console.log('PASS: recursive asset cleanup preserves build inputs; clean builds reproduce all three exact release assets twice.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
