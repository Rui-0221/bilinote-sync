const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const source = nativeFs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function load(overrides = {}) {
  const context = {
    require: name => name === 'obsidian' ? { Plugin: class {}, PluginSettingTab: class {}, Setting: class {}, Notice: class {}, Modal: class {} }
      : name === 'node:fs/promises' ? { ...fs, ...overrides } : require(name),
    module: { exports: {} }, Buffer, process, Map, Date,
  };
  vm.runInNewContext(source, context, { filename: 'main.js' });
  return context.module.exports.testing;
}

async function main() {
  const root = await fs.mkdtemp(path.join(__dirname, 'hardlink-test-'));
  const appDir = path.join(root, 'app');
  const vaultDir = path.join(root, 'vault');
  const screenshots = path.join(appDir, 'static', 'screenshots');
  await fs.mkdir(path.join(appDir, 'note_results'), { recursive: true });
  await fs.mkdir(screenshots, { recursive: true });
  await fs.mkdir(vaultDir);
  function target(relative) {
    const file = path.resolve(vaultDir, relative);
    assert.ok(file.startsWith(vaultDir + path.sep), 'all fixture writes stay in the vault');
    return file;
  }
  const vault = {
    getMarkdownFiles: () => nativeFs.readdirSync(vaultDir, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
      .map(entry => ({ path: path.relative(vaultDir, path.join(entry.parentPath || entry.path, entry.name)).replace(/\\/g, '/') })),
    read: async file => fs.readFile(target(file.path), 'utf8'),
    adapter: {
      getBasePath: () => vaultDir,
      exists: async name => { try { await fs.access(target(name)); return true; } catch { return false; } },
      readBinary: async name => fs.readFile(target(name)),
    },
    createFolder: async name => fs.mkdir(target(name)),
    createBinary: async (name, bytes) => fs.writeFile(target(name), Buffer.from(bytes), { flag: 'wx' }),
    create: async (name, text) => fs.writeFile(target(name), text, { flag: 'wx' }),
  };
  const id = '00000000-0000-0000-0000-000000000001';
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6C0sAAAAASUVORK5CYII=', 'base64');
  await fs.writeFile(path.join(screenshots, 'first.png'), bytes);
  await fs.writeFile(path.join(screenshots, 'second.png'), bytes);
  await fs.writeFile(path.join(appDir, 'note_results', `${id}.status.json`), JSON.stringify({ status: 'SUCCESS' }));
  await fs.writeFile(path.join(appDir, 'note_results', `${id}.json`), JSON.stringify({
    markdown: '# 教程\n![](/static/screenshots/first.png)\n![](/static/screenshots/second.png)',
    audio_meta: { title: '硬链接验证', video_id: 'BVtest', platform: 'bilibili' },
  }));
  const { syncResults, shareExistingImages, sameFile } = load();
  const options = folder => ({ vault, settings: { sourceDir: appDir, folder, sharedImages: true }, imports: {}, save: async () => {} });
  function assets(folder) { return fs.readdir(target(`${folder}/附件/${id}`)); }
  async function imagePath(folder, prefix) {
    const names = await assets(folder);
    return target(`${folder}/附件/${id}/${names.find(name => name.startsWith(prefix + '-'))}`);
  }

  const linked = await syncResults(options('shared'));
  assert.equal(linked.errors.length, 0);
  assert.equal(linked.imported[0].linkedImages, 2);
  const firstShared = await imagePath('shared', 'first');
  const originalStat = await fs.stat(path.join(screenshots, 'first.png'), { bigint: true });
  const linkedStat = await fs.stat(firstShared, { bigint: true });
  assert.ok(sameFile(originalStat, linkedStat), 'new imports share the original filesystem file ID');
  assert.ok(linkedStat.nlink >= 2n, 'the source and vault are both hard links');
  assert.equal((await syncResults(options('shared'))).imported.length, 0, 'hard-linked import remains idempotent');

  const copiedOptions = options('copies');
  copiedOptions.settings.sharedImages = false;
  const copied = await syncResults(copiedOptions);
  assert.equal(copied.imported[0].linkedImages, 0);
  const firstCopy = await imagePath('copies', 'first');
  const secondCopy = await imagePath('copies', 'second');
  assert.ok(!sameFile(originalStat, await fs.stat(firstCopy, { bigint: true })), 'copy setting gives an independent file');
  await fs.writeFile(secondCopy, Buffer.from('用户修改的图片'));
  const conversion = await shareExistingImages(vault, copiedOptions.settings);
  assert.equal(conversion.linked, 1);
  assert.equal(conversion.skipped, 1, 'modified images are preserved');
  assert.equal(conversion.errors.length, 0);
  assert.equal(conversion.bytesReleased, bytes.length);
  assert.ok(sameFile(originalStat, await fs.stat(firstCopy, { bigint: true })), 'existing identical copy becomes a hard link');
  assert.equal(await fs.readFile(secondCopy, 'utf8'), '用户修改的图片');
  const repeat = await shareExistingImages(vault, copiedOptions.settings);
  assert.equal(repeat.linked, 0);
  assert.equal(repeat.alreadyShared, 1);

  const failingLink = load({ link: async () => { const error = new Error('模拟跨磁盘'); error.code = 'EXDEV'; throw error; } });
  const fallback = await failingLink.syncResults(options('fallback'));
  assert.equal(fallback.errors.length, 0);
  assert.equal(fallback.imported[0].linkedImages, 0, 'cross-filesystem linking safely falls back to copying');
  assert.deepEqual(await fs.readFile(await imagePath('fallback', 'first')), bytes);

  const rollbackOptions = options('rollback');
  rollbackOptions.settings.sharedImages = false;
  await syncResults(rollbackOptions);
  let failOnce = true;
  const failedReplacement = load({ rename: async (from, to) => {
    if (failOnce && from.includes('.shared-')) {
      failOnce = false;
      const error = new Error('模拟替换失败'); error.code = 'EACCES'; throw error;
    }
    return fs.rename(from, to);
  } });
  const rollback = await failedReplacement.shareExistingImages(vault, rollbackOptions.settings);
  assert.equal(rollback.errors.length, 1);
  assert.equal(rollback.linked, 1);
  assert.deepEqual(await fs.readFile(await imagePath('rollback', 'first')), bytes, 'failed replacement restores the original copy');
  assert.ok(!(await assets('rollback')).some(name => name.includes('.copy-') || name.includes('.shared-')), 'successful rollback leaves no temporary names');

  await fs.unlink(path.join(screenshots, 'first.png'));
  assert.deepEqual(await fs.readFile(firstShared), bytes, 'removing the BiliNote filename does not remove the vault image data');
  console.log('PASS: actual hard-link file identity, duplicate import prevention, copy option, unchanged-copy conversion, modified-image preservation, conversion idempotence, cross-filesystem fallback, replacement rollback, source-name deletion survival.');
  console.log('Fixture retained at: ' + root);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
