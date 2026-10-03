const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
async function main() {
  const root = path.resolve(__dirname, '..');
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const versions = JSON.parse(await fs.readFile(path.join(root, 'versions.json'), 'utf8'));
  assert.match(manifest.id, /^[a-z]+(?:-[a-z]+)*$/); assert.ok(!manifest.id.includes('obsidian') && !manifest.id.endsWith('plugin'));
  assert.match(manifest.name, /^[A-Za-z0-9 +()-]+$/); assert.ok(!/obsidian|plugin/i.test(manifest.name));
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/); assert.equal(pkg.version, manifest.version);
  assert.equal(versions[manifest.version], manifest.minAppVersion); assert.equal(manifest.isDesktopOnly, true);
  assert.ok(manifest.description.length <= 250 && manifest.description.endsWith('.'));
  const allow = ['main.js', 'manifest.json', 'styles.css', 'package.json', 'package-lock.json', 'eslint.config.mjs', 'versions.json', 'README.md', 'README.zh-CN.md', 'PUBLISHING.md', 'CHANGELOG.md', 'LICENSE', '.gitignore',
    'verify.cjs', 'verify-hardlinks.cjs', 'verify-selective-import.cjs', 'verify-community-audit.cjs', 'scripts/check-release.cjs', 'scripts/prepare-release.cjs', 'scripts/verify-build.cjs', 'src/main.js', 'src/styles.css', '.github/workflows/release.yml'];
  for (const name of allow) {
    const text = await fs.readFile(path.join(root, name), 'utf8');
    assert.ok(!/[A-Za-z]:[\\/]+Users[\\/]+(?:Public|[^\\/\s]+)/i.test(text), 'private installation/user path in ' + name);
    assert.ok(!/sk-[A-Za-z0-9_-]{20,}|SESSDATA\s*[=:]\s*[A-Za-z0-9%]{10,}/.test(text), 'credential-like value in ' + name);
  }
  const entries = await fs.readdir(root);
  for (const entry of entries) assert.ok(allow.includes(entry) || ['scripts', 'src', '.github', 'node_modules', '.release', '.git'].includes(entry) || /^(test|hardlink-test|selective-test|audit-test)-/.test(entry), 'unexpected public root entry: ' + entry);
  for (const file of ['main.js', 'styles.css']) assert.deepEqual(await fs.readFile(path.join(root, file)), await fs.readFile(path.join(root, 'src', file)), 'built installation asset differs from source: ' + file);
  assert.ok(!(pkg.dependencies && Object.keys(pkg.dependencies).length), 'runtime dependencies are not bundled');
  console.log('PASS: release manifest, version alignment, source allowlist, no private paths or credential-like values, no runtime dependencies.');
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
