const fs = require('node:fs/promises');
const vm = require('node:vm');
const path = require('node:path');
const assert = require('node:assert/strict');
const script = require('node:fs').readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const context = { require: name => name === 'obsidian' ? { Plugin: class {}, PluginSettingTab: class {}, Setting: class {}, Notice: class {}, Modal: class {} } : require(name),
  module: { exports: {} }, Buffer, process, Map, Date };
vm.runInNewContext(script, context, { filename: 'main.js' });
const { syncResults, screenshotName, validateFolder } = context.module.exports.testing;
const ids = ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000004'];

async function main() {
  const root = await fs.mkdtemp(path.join(__dirname, 'test-'));
  const appDir = path.join(root, 'app');
  const vaultDir = path.join(root, 'vault');
  await fs.mkdir(path.join(appDir, 'note_results'), { recursive: true });
  await fs.mkdir(path.join(appDir, 'static', 'screenshots'), { recursive: true });
  await fs.mkdir(vaultDir);
  function target(relative) {
    const file = path.resolve(vaultDir, relative);
    assert.ok(file.startsWith(vaultDir + path.sep), 'all writes stay in the fixture vault');
    return file;
  }
  const vault = {
    getMarkdownFiles: () => require('node:fs').readdirSync(vaultDir, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
      .map(entry => ({ path: path.relative(vaultDir, path.join(entry.parentPath || entry.path, entry.name)).replace(/\\/g, '/') })),
    read: async file => fs.readFile(target(file.path), 'utf8'),
    adapter: {
      exists: async name => { try { await fs.access(target(name)); return true; } catch { return false; } },
      readBinary: async name => fs.readFile(target(name)),
    },
    createFolder: async name => fs.mkdir(target(name)),
    createBinary: async (name, bytes) => fs.writeFile(target(name), Buffer.from(bytes), { flag: 'wx' }),
    create: async (name, text) => fs.writeFile(target(name), text, { flag: 'wx' }),
  };
  const imports = {};
  let saveCount = 0;
  const options = { vault, settings: { sourceDir: appDir, folder: 'BiliNote笔记' }, imports,
    save: async () => { saveCount++; await fs.writeFile(path.join(root, 'imports.json'), JSON.stringify(imports)); } };
  async function result(id, markdown, status = 'SUCCESS') {
    await fs.writeFile(path.join(appDir, 'note_results', `${id}.status.json`), JSON.stringify({ status }));
    await fs.writeFile(path.join(appDir, 'note_results', `${id}.json`), JSON.stringify({ markdown,
      audio_meta: { title: '软件教程：安装/配置', video_id: 'BVtest', platform: 'bilibili' }, transcript: {} }));
  }
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6C0sAAAAASUVORK5CYII=', 'base64');
  await fs.writeFile(path.join(appDir, 'static', 'screenshots', 'first.png'), imageBytes);
  const body = '# 操作教程\n\n![界面](/static/screenshots/first.png)\n' +
    '![重复截图](<http://127.0.0.1:8483/static/screenshots/first.png>)\n' +
    '![远程图片](https://example.invalid/static/screenshots/remote.png)\n';
  await result(ids[0], body);
  await result(ids[1], '# 正在生成，不能导入', 'SUMMARIZING');
  await fs.writeFile(path.join(appDir, 'note_results', `${ids[0]}_markdown.md`), '中间结果不得导入');

  let summary = await syncResults(options);
  assert.equal(summary.imported.length, 1);
  assert.equal(summary.imported[0].images, 1, 'duplicate image references copy one asset');
  assert.equal(summary.errors.length, 0);
  const firstPath = summary.imported[0].path;
  let importedText = await fs.readFile(target(firstPath), 'utf8');
  assert.ok(importedText.includes('bilinote_task: "' + ids[0] + '"'));
  assert.ok(decodeURIComponent(importedText).includes('![界面](<附件/'));
  assert.ok(!importedText.includes('](/static/screenshots/'));
  assert.ok(importedText.includes('https://example.invalid/static/screenshots/remote.png'), 'remote references remain intact');
  const assetLink = importedText.match(/!\[界面\]\(<([^>]+)>\)/)[1];
  assert.deepEqual(await fs.readFile(target(path.posix.join(path.posix.dirname(firstPath), decodeURIComponent(assetLink)))), imageBytes);
  assert.equal((await syncResults(options)).imported.length, 0, 'repeated scans are idempotent');
  const restored = await syncResults({ ...options, imports: {}, save: async () => {} });
  assert.equal(restored.imported.length, 0, 'note metadata prevents duplicates when saved plugin state is lost');
  assert.equal(restored.skipped, 1);

  importedText += '\n我的个人补充：请保留。\n';
  await fs.writeFile(target(firstPath), importedText);
  await result(ids[0], body + '\n新版本追加的步骤。\n');
  summary = await syncResults(options);
  assert.equal(summary.imported.length, 1);
  assert.notEqual(summary.imported[0].path, firstPath, 'a regenerated source gets a separate version');
  assert.equal(await fs.readFile(target(firstPath), 'utf8'), importedText, 'personal edits are never overwritten');
  assert.equal((await fs.readdir(target(`BiliNote笔记/附件/${ids[0]}`))).length, 1, 'same asset is reused across versions');

  await result(ids[2], '# 尚缺图片\n![](/static/screenshots/later.png)');
  summary = await syncResults(options);
  assert.equal(summary.imported.length, 0);
  assert.equal(summary.errors.length, 1, 'missing screenshots defer the whole note');
  await fs.writeFile(path.join(appDir, 'static', 'screenshots', 'later.png'), imageBytes);
  summary = await syncResults(options);
  assert.equal(summary.imported.length, 1, 'a later scan completes the deferred result');
  assert.equal(summary.errors.length, 0);

  await result(ids[3], '# 恢复后的完整结果');
  await fs.writeFile(path.join(appDir, 'note_results', `${ids[3]}.json`), '{"markdown":');
  summary = await syncResults(options);
  assert.equal(summary.errors.length, 1, 'a partial JSON is not imported');
  await result(ids[3], '# 恢复后的完整结果');
  assert.equal((await syncResults(options)).imported.length, 1, 'partial writes are retried');
  for (const value of ['../outside', '.obsidian', 'C:/outside', '/outside', 'note//bad']) assert.throws(() => validateFolder(value));
  for (const value of ['/static/screenshots/..%2fsecret.png', '/static/screenshots/..%5csecret.png', '/static/screenshots/secret.txt']) assert.throws(() => screenshotName(value));
  assert.equal(screenshotName('https://elsewhere.test/static/screenshots/file.png'), null);
  assert.equal((await syncResults({ ...options, isActive: () => false })).imported.length, 0, 'unloaded plugin stops importing');
  assert.equal(saveCount, 4);
  await result(ids[1], '# 保存状态失败之后仍可恢复');
  const failedSave = await syncResults({ ...options, save: async () => { throw new Error('模拟状态保存失败'); } });
  assert.equal(failedSave.errors.length, 1);
  assert.equal((await syncResults(options)).imported.length, 0, 'failed state persistence retries without creating a duplicate note');
  assert.equal(saveCount, 5);
  console.log('PASS: completed-result filtering, local image copying and relinking, repeat-scan deduplication, edited-note preservation, separate source versions, delayed images, partial JSON retry, directory boundaries, unload handling.');
  console.log('Fixture retained at: ' + root);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
