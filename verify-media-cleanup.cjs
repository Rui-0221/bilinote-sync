const fs = require('node:fs/promises');
const native = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = native.readFileSync(process.argv[2] || path.join(__dirname, 'main.js'), 'utf8');
const id = n => `20000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const bv = 'BV' + '0'.repeat(10);
const failures = [];
function load(overrides = {}) {
  const context = { require: name => name === 'obsidian'
    ? { Plugin: class {}, Modal: class {}, PluginSettingTab: class {}, Notice: class {} }
    : name === 'node:fs/promises' ? { ...fs, ...overrides } : require(name),
    module: { exports: {} }, Buffer, process };
  vm.runInNewContext(source, context);
  return context.module.exports.testing;
}
const code = load();
async function fixture(root, name) {
  const base = path.join(root, name), appDir = path.join(base, 'app'), vaultDir = path.join(base, 'vault');
  const results = path.join(appDir, 'note_results'), data = path.join(appDir, 'data');
  await fs.mkdir(results, { recursive: true });
  await fs.mkdir(data); await fs.mkdir(vaultDir);
  const target = p => {
    const resolved = path.resolve(vaultDir, p);
    assert.ok(resolved.startsWith(vaultDir + path.sep)); return resolved;
  };
  const files = () => native.readdirSync(vaultDir, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.md'))
    .map(e => ({ path: path.relative(vaultDir, path.join(e.parentPath || e.path, e.name)).replace(/\\/g, '/') }));
  const vault = { getMarkdownFiles: files, getAbstractFileByPath: p => native.existsSync(target(p)) ? { path: p } : null,
    read: f => fs.readFile(target(f.path), 'utf8'),
    adapter: { getBasePath: () => vaultDir, exists: async p => native.existsSync(target(p)), readBinary: p => fs.readFile(target(p)) },
    createFolder: p => fs.mkdir(target(p)), create: (p, t) => fs.writeFile(target(p), t, { flag: 'wx' }),
    createBinary: (p, b) => fs.writeFile(target(p), Buffer.from(b), { flag: 'wx' }) };
  const options = { vault, settings: { sourceDir: appDir, folder: 'notes', autoCleanup: false, sharedImages: false }, imports: {}, save: async () => {} };
  const json = async (relative, value) => {
    const file = path.join(results, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value));
  };
  const task = async (n, status, videoId, url) => {
    if (status) await json(id(n) + '.status.json', { status });
    if (videoId) await json(id(n) + '_audio.json', { video_id: videoId });
    if (url) await json('task_requests/' + id(n) + '.json', { form_data: { video_url: url } });
  };
  const completed = async (n, videoId) => {
    await task(n, 'SUCCESS');
    await json(id(n) + '.json', { markdown: '# tutorial ' + n, audio_meta: { title: 'tutorial ' + n, video_id: videoId } });
  };
  const media = async videoId => {
    const file = path.join(data, videoId + '.mp4');
    await fs.writeFile(file, 'synthetic cached video'); await fs.utimes(file, new Date(0), new Date(0)); return file;
  };
  const imported = async videoId => {
    await completed(1, videoId); const result = await code.syncResults({ ...options, taskIds: [id(1)] });
    assert.equal(result.imported.length, 1); return media(videoId);
  };
  return { appDir, results, data, options, json, task, completed, media, imported };
}
async function test(name, fn) {
  try { await fn(); console.log('PASS: ' + name); }
  catch (error) { failures.push(name); console.error('FAIL: ' + name + ': ' + error.message); }
}
async function retained(f, file, implementation = code) {
  const result = await implementation.cleanupCompletedMedia(f.options);
  assert.equal(result.deleted.length, 0); assert.ok(native.existsSync(file)); return result;
}
async function removed(f, file) {
  const result = await code.cleanupCompletedMedia(f.options);
  assert.equal(result.errors.length, 0); assert.equal(result.deleted.length, 1); assert.equal(native.existsSync(file), false);
}
async function main() {
  const root = await fs.mkdtemp(path.join(__dirname, 'audit-test-media-'));
  await test('completed episode can be cleaned while a different episode is generating', async () => {
    const f = await fixture(root, 'independent'), first = await f.imported(bv + '_p1'), second = await f.media(bv + '_p2');
    await f.task(2, 'PENDING', null, 'https://www.bilibili.com/video/' + bv + '/?p=2');
    await removed(f, first); assert.ok(native.existsSync(second));
  });
  for (const status of ['PENDING', 'GENERATING', 'FAILED', 'ERROR']) {
    await test(status + ' same-video task protects retry/shared cache', async () => {
      const f = await fixture(root, 'same-' + status), file = await f.imported('shared');
      await f.task(2, status, 'shared'); await retained(f, file);
    });
  }
  for (const status of ['PENDING', 'FAILED', 'ERROR']) {
    await test(status + ' without media identity conservatively protects cached files', async () => {
      const f = await fixture(root, 'unknown-' + status), file = await f.imported('unknown');
      await f.task(2, status); await retained(f, file);
    });
  }
  await test('removed failed task releases only its cache reference', async () => {
    const f = await fixture(root, 'removed-failed'), file = await f.imported('removed');
    await f.task(2, 'FAILED', 'removed'); await f.json('series_task_removals.json', { task_ids: [id(2)] }); await removed(f, file);
  });
  await test('removed history entry cannot release a still-running task', async () => {
    const f = await fixture(root, 'removed-running'), file = await f.imported('running');
    await f.task(2, 'PENDING', 'running'); await f.json('series_task_removals.json', { task_ids: [id(2)] }); await retained(f, file);
  });
  for (const status of ['CANCELLED', 'CANCELED']) {
    await test(status + ' terminal task releases its reference', async () => {
      const f = await fixture(root, 'cancel-' + status), file = await f.imported('cancelled');
      await f.task(2, status, 'cancelled'); await removed(f, file);
    });
  }
  for (const videoId of [bv, bv + '_p1']) {
    await test('first-episode URL protects legacy and explicit first-episode cache names: ' + videoId.slice(-3), async () => {
      const f = await fixture(root, 'alias-' + videoId), file = await f.imported(videoId);
      await f.task(2, 'PENDING', null, 'https://www.bilibili.com/video/' + bv + '/'); await retained(f, file);
    });
  }
  await test('known absolute media path protects a task without video_id', async () => {
    const f = await fixture(root, 'audio-path'), file = await f.imported('path-cache');
    await f.task(2, 'DOWNLOADING'); await f.json(id(2) + '_audio.json', { file_path: file }); await retained(f, file);
  });
  await test('series receipts and queued requests protect tasks before status creation', async () => {
    const f = await fixture(root, 'batch'), file = await f.imported(bv + '_p3');
    await f.json('series_batches/batch.json', { tasks: [{ task_id: id(2), video_url: 'https://www.bilibili.com/video/' + bv + '/?p=3' }] });
    await retained(f, file);
    const g = await fixture(root, 'request'), other = await g.imported('youtube-id');
    await g.task(2, null, null, 'https://youtu.be/youtube-id'); await retained(g, other);
  });
  await test('unimported completed task protects a cache shared with an imported task', async () => {
    const f = await fixture(root, 'unimported'), file = await f.imported('same');
    await f.completed(2, 'same'); await retained(f, file);
  });
  await test('unimported first-episode result protects a legacy cache alias', async () => {
    const f = await fixture(root, 'unimported-alias'), file = await f.imported(bv);
    await f.completed(2, bv + '_p1'); await retained(f, file);
  });
  await test('corrupt completed result protects its media, without blocking unrelated completed media', async () => {
    const f = await fixture(root, 'corrupt-result'), file = await f.imported('corrupt');
    await f.task(2, 'SUCCESS', 'corrupt'); await fs.writeFile(path.join(f.results, id(2) + '.json'), '{');
    await retained(f, file);
    await f.completed(3, 'independent'); await code.syncResults({ ...f.options, taskIds: [id(3)] });
    const independent = await f.media('independent');
    const result = await code.cleanupCompletedMedia(f.options);
    assert.equal(result.deleted.length, 1); assert.ok(native.existsSync(file)); assert.equal(native.existsSync(independent), false);
  });
  await test('result with missing status still protects a shared cache', async () => {
    const f = await fixture(root, 'missing-status'), file = await f.imported('orphan');
    await f.json(id(2) + '.json', { markdown: '# unfinished', audio_meta: { video_id: 'orphan' } }); await retained(f, file);
  });
  await test('malformed series receipt defers deletion rather than overlooking queued work', async () => {
    const f = await fixture(root, 'corrupt-batch'), file = await f.imported('batch');
    await fs.mkdir(path.join(f.results, 'series_batches')); await fs.writeFile(path.join(f.results, 'series_batches/batch.json'), '{');
    await retained(f, file);
  });
  await test('cache rewritten during final task scan survives deletion', async () => {
    const f = await fixture(root, 'rewrite'), file = await f.imported('changing'); let reads = 0;
    const implementation = load({ readFile: async (target, ...args) => {
      if (path.basename(target) === 'series_task_removals.json' && ++reads === 2) await fs.writeFile(file, 'new cached bytes during final scan');
      return fs.readFile(target, ...args);
    } });
    const result = await retained(f, file, implementation);
    assert.ok(result.errors.length); assert.equal(await fs.readFile(file, 'utf8'), 'new cached bytes during final scan');
  });
  await test('retry started at the final task scan protects its media', async () => {
    const f = await fixture(root, 'retry-race'), file = await f.imported('retry'); let scans = 0;
    const implementation = load({ readdir: async (target, ...args) => {
      if (target === f.results && ++scans === 3) await f.task(2, 'PENDING', 'retry');
      return fs.readdir(target, ...args);
    } });
    await retained(f, file, implementation); assert.ok(scans >= 3);
  });
  await test('new unimported result completed during final scan protects shared media', async () => {
    const f = await fixture(root, 'success-race'), file = await f.imported('just-completed'); let scans = 0;
    const implementation = load({ readdir: async (target, ...args) => {
      if (target === f.results && ++scans === 3) await f.completed(2, 'just-completed');
      return fs.readdir(target, ...args);
    } });
    await retained(f, file, implementation); assert.ok(scans >= 3);
  });
  console.log('Synthetic fixtures retained at: ' + root);
  if (failures.length) throw new Error(failures.length + ' media cleanup cases failed');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
