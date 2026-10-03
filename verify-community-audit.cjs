const fs = require('node:fs/promises');
const native = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = native.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
let store = {};
class Element {
  constructor(tag = 'div', options = {}) { this.tag = tag; this.options = options; this.children = []; this.dataset = {}; this.events = {}; }
  createEl(tag, options = {}) { const e = new Element(tag, options); this.children.push(e); return e; }
  createDiv(o) { return this.createEl('div', o); }
  addClass() {} setText(t) { this.text = t; } empty() { this.children = []; }
  addEventListener(e, f) { this.events[e] = f; }
}
class Plugin {
  constructor(app) { this.app = app; }
  async loadData() { return structuredClone(store); }
  async saveData(d) { store = structuredClone(d); }
  addSettingTab(tab) { this.tab = tab; } addCommand() {} addRibbonIcon() {} registerInterval() {}
}
class Modal {
  constructor(app) { this.app = app; this.contentEl = new Element(); this.titleEl = new Element(); }
  open() { this.onOpen(); } close() { this.onClose(); }
}
function load(overrides = {}) {
  const context = { require: n => n === 'obsidian' ? { Plugin, Modal, PluginSettingTab: class {}, Setting: class {}, Notice: class {} }
    : n === 'node:fs/promises' ? { ...fs, ...overrides } : require(n), module: { exports: {} }, Buffer, process, window: { setInterval: () => 1 } };
  vm.runInNewContext(source, context);
  return context.module.exports;
}
const code = load(), { syncResults, listCompletedNotes, cleanupCompletedMedia, DEFAULTS } = code.testing;
const id = n => `10000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const failures = [];
async function test(name, fn) {
  try { await fn(); console.log('PASS: ' + name); }
  catch (e) { failures.push(name); console.error('FAIL: ' + name + ': ' + e.message); }
}
async function fixture(root, name) {
  const base = path.join(root, name), appDir = path.join(base, 'app'), vaultDir = path.join(base, 'vault');
  await fs.mkdir(path.join(appDir, 'note_results'), { recursive: true });
  await fs.mkdir(path.join(appDir, 'static/screenshots'), { recursive: true });
  await fs.mkdir(path.join(appDir, 'data')); await fs.mkdir(vaultDir);
  const target = p => { const resolved = path.resolve(vaultDir, p); assert.ok(resolved.startsWith(vaultDir + path.sep)); return resolved; };
  const files = () => native.readdirSync(vaultDir, { recursive: true, withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.md'))
    .map(e => ({ path: path.relative(vaultDir, path.join(e.parentPath || e.path, e.name)).replace(/\\/g, '/') }));
  const vault = { getMarkdownFiles: files, getAbstractFileByPath: p => native.existsSync(target(p)) ? { path: p } : null,
    read: f => fs.readFile(target(f.path), 'utf8'), adapter: { getBasePath: () => vaultDir, exists: async p => native.existsSync(target(p)), readBinary: p => fs.readFile(target(p)) },
    createFolder: p => fs.mkdir(target(p)), create: (p, t) => fs.writeFile(target(p), t, { flag: 'wx' }), createBinary: (p, b) => fs.writeFile(target(p), Buffer.from(b), { flag: 'wx' }) };
  const settings = { sourceDir: appDir, folder: 'notes', sharedImages: false, autoCleanup: false, autoSync: false, promptOnStartup: true };
  const options = { vault, settings, imports: {}, save: async () => {} };
  async function result(n, markdown = '# tutorial', extra = {}) {
    await fs.writeFile(path.join(appDir, 'note_results', id(n) + '.status.json'), JSON.stringify({ status: 'SUCCESS' }));
    await fs.writeFile(path.join(appDir, 'note_results', id(n) + '.json'), JSON.stringify({ markdown, audio_meta: { title: 'tutorial ' + n, video_id: 'BVtest' + n, platform: 'bilibili', ...extra } }));
  }
  return { appDir, vaultDir, target, files, vault, options, settings, result };
}
async function main() {
  const root = await fs.mkdtemp(path.join(__dirname, 'audit-test-'));
  await test('public defaults do not assume an installation or enable shared-file mutation/deletion', async () => {
    assert.equal(DEFAULTS.sourceDir, ''); assert.equal(DEFAULTS.autoCleanup, false); assert.equal(DEFAULTS.sharedImages, false);
  });
  await test('deleted note is selectable for explicit restoration; automatic sync respects deletion', async () => {
    const f = await fixture(root, 'deleted'); await f.result(1);
    const first = (await syncResults(f.options)).imported[0]; await fs.unlink(f.target(first.path));
    const report = await listCompletedNotes(f.options); assert.equal(report.notes[0].state, 'missing');
    assert.equal((await syncResults(f.options)).imported.length, 0);
    const restored = await syncResults({ ...f.options, taskIds: [id(1)] }); assert.equal(restored.imported.length, 1);
  });
  await test('renamed note is recovered, without a duplicate; unquoted YAML receipt survives property edits', async () => {
    const f = await fixture(root, 'renamed'); await f.result(1);
    const first = (await syncResults(f.options)).imported[0], renamed = 'notes/my edited name.md';
    const text = (await fs.readFile(f.target(first.path), 'utf8')).replace(/^(bilinote_task|bilinote_source_hash): "([^"]+)"$/gm, '$1: $2');
    await fs.rename(f.target(first.path), f.target(renamed)); await fs.writeFile(f.target(renamed), text + '\nmy edits\n');
    const report = await listCompletedNotes(f.options); assert.equal(report.notes[0].importedPath, renamed);
    const result = await syncResults(f.options); assert.equal(result.imported.length, 0); assert.equal(f.files().length, 1);
    assert.equal(Object.values(f.options.imports)[0].path, renamed);
  });
  await test('percent/hash characters in screenshot paths round-trip in Markdown URLs', async () => {
    const f = await fixture(root, 'url'), image = 'demo%20#one.png';
    await fs.writeFile(path.join(f.appDir, 'static/screenshots', image), 'image bytes');
    await f.result(1, '![](/static/screenshots/' + encodeURIComponent(image) + ')');
    const result = await syncResults(f.options); assert.equal(result.errors.length, 0);
    const text = await fs.readFile(f.target(result.imported[0].path), 'utf8');
    const url = text.match(/!\[\]\(<([^>]+)>\)/)[1]; assert.ok(!url.includes('#'));
    assert.equal(await fs.readFile(f.target(path.posix.join('notes', decodeURIComponent(url))), 'utf8'), 'image bytes');
  });
  await test('a redirected vault folder cannot write an imported note outside the vault', async () => {
    const f = await fixture(root, 'boundary'), outside = path.join(root, 'outside'); await fs.mkdir(outside);
    await fs.symlink(outside, f.target('notes'), process.platform === 'win32' ? 'junction' : 'dir'); await f.result(1);
    const result = await syncResults(f.options); assert.equal(result.imported.length, 0); assert.ok(result.errors.length);
    assert.equal((await fs.readdir(outside)).length, 0);
  });
  await test('selection cannot silently follow a source/folder setting change', async () => {
    const f = await fixture(root, 'context'); await f.result(1); store = { settings: f.settings };
    const p = new code({ vault: f.vault, workspace: { onLayoutReady: () => {} } }); await p.onload(); await p.openPicker();
    p.picker.selected.add(id(1)); p.settings.folder = 'changed'; await p.picker.importSelected();
    assert.equal(f.files().length, 0); p.onunload();
  });
  await test('cache cleanup cannot delete another video through arbitrary metadata paths', async () => {
    const f = await fixture(root, 'cache'); const other = path.join(f.appDir, 'data/BVtest2.mp4');
    await f.result(1, '# selected', { file_path: other }); await f.result(2, '# not selected');
    await syncResults({ ...f.options, taskIds: [id(1)] }); await fs.writeFile(other, 'unselected video');
    await fs.utimes(other, new Date(0), new Date(0));
    const result = await cleanupCompletedMedia({ ...f.options, taskIds: [id(1)] });
    assert.equal(result.deleted.length, 0); assert.ok(native.existsSync(other));
  });
  await test('changing a screenshot during hard-link creation defers the note', async () => {
    const f = await fixture(root, 'image-race'); await fs.writeFile(path.join(f.appDir, 'static/screenshots/demo.png'), 'before');
    await f.result(1, '![](/static/screenshots/demo.png)'); f.settings.sharedImages = true;
    const changed = load({ link: async (from, to) => { await fs.writeFile(from, 'after'); return fs.link(from, to); } });
    const result = await changed.testing.syncResults(f.options); assert.equal(result.imported.length, 0); assert.ok(result.errors.length);
  });
  await test('state writes are serialized and capture settings at the time of saving', async () => {
    store = {}; const p = new code({ workspace: { onLayoutReady: () => {} } }); await p.onload();
    let resolveFirst, firstStarted; const started = new Promise(r => { firstStarted = r; }); const written = []; let n = 0;
    p.saveData = async value => { if (++n === 1) { firstStarted(); await new Promise(r => { resolveFirst = r; }); } written.push(value.settings.folder); };
    p.settings.folder = 'first'; const a = p.persist(); await started;
    p.settings.folder = 'second'; const b = p.persist(); await Promise.resolve(); resolveFirst(); await Promise.all([a, b]);
    assert.deepEqual(written, ['first', 'second']); p.onunload();
  });
  await test('declarative settings are searchable and save the wrapped data without losing import receipts', async () => {
    store = { imports: { synthetic: { path: 'notes/example.md' } } };
    const p = new code({ workspace: { onLayoutReady: () => {} } }); await p.onload();
    const definitions = p.tab.getSettingDefinitions(); assert.equal(definitions.length, 10);
    assert.ok(definitions.some(d => d.name === '自动同步全部笔记'));
    let change;
    definitions.find(d => d.name === '自动同步全部笔记').render({ addToggle: callback => callback({ setValue: () => ({ onChange: fn => { change = fn; } }) }) });
    await change(true); assert.equal(store.settings.autoSync, true); assert.ok(store.imports.synthetic);
    p.onunload();
  });
  console.log('Fixture retained at: ' + root);
  if (failures.length) throw new Error(failures.length + ' audit cases failed');
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
