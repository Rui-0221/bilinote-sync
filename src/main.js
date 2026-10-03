const { Plugin, PluginSettingTab, Notice, Modal } = require('obsidian');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULTS = {
  sourceDir: '',
  folder: 'BiliNote笔记',
  autoSync: false,
  promptOnStartup: true,
  sharedImages: false,
  autoCleanup: false,
};
const RESULT_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i;
const TASK_STATUS_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.status\.json$/i;
const MEDIA_EXTENSIONS = new Set(['.mp3', '.mp4', '.m4a', '.m4v', '.webm', '.wav', '.aac', '.flac', '.ogg', '.opus', '.mkv', '.mov', '.avi']);
const IMAGE = /!\[([^\]\r\n]*)\]\(\s*(?:<([^>\r\n]+)>|([^\s)\r\n]+))(?:\s+(["'][^\r\n]*?["']))?\s*\)/g;

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function pathKey(value) { return process.platform === 'win32' ? value.toLowerCase() : value; }
function importKey(appDir, folder, taskId) { return JSON.stringify([pathKey(appDir), folder, taskId]); }
function contextKey(settings) { return JSON.stringify([settings.sourceDir, settings.folder, settings.sharedImages]); }
function hasControlChars(value) { return Array.from(value).some(character => character.codePointAt(0) < 32 || character.codePointAt(0) === 127); }

function validateFolder(value) {
  const folder = String(value || '').trim().replace(/\\/g, '/').replace(/\/$/, '');
  if (!folder || path.posix.isAbsolute(folder) || /^[A-Za-z]:/.test(folder) ||
      folder.split('/').some(part => !part || part.startsWith('.') || /[:*?"<>|]/.test(part) || hasControlChars(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('同步目录必须是仓库内的普通文件夹，例如 BiliNote笔记。');
  }
  return folder;
}

function safeName(value) {
  const name = Array.from(String(value || '视频笔记').replace(/[\\/:*?"<>|]/g, '-')).map(character => hasControlChars(character) ? '-' : character).slice(0, 90).join('').replace(/[. ]+$/, '');
  return name && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? name : '视频笔记';
}

function screenshotName(url) {
  const match = String(url).match(/^(?:https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?)?\/static\/screenshots\/(.+)$/i);
  if (!match) return null;
  let name;
  try { name = decodeURIComponent(match[1].split(/[?#]/)[0]); }
  catch { throw new Error('截图链接编码无效。'); }
  if (!name || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name) || hasControlChars(name) ||
      !/\.(?:png|jpe?g|webp|gif|avif)$/i.test(name)) {
    throw new Error('截图链接不是截图目录中的图片文件。');
  }
  return name;
}

function within(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function ensureFolder(vault, folder) {
  const root = typeof vault.adapter.getBasePath === 'function' ? await fs.realpath(vault.adapter.getBasePath()) : null;
  let current = '';
  for (const part of folder.split('/')) {
    current = current ? `${current}/${part}` : part;
    if (root) {
      const parent = await fs.realpath(path.dirname(path.resolve(root, current)));
      if (parent !== root && !within(root, parent)) throw new Error('笔记目录指向仓库之外，已停止导入。');
    }
    if (!await vault.adapter.exists(current)) await vault.createFolder(current);
    if (root && !within(root, await fs.realpath(path.resolve(root, current)))) throw new Error('笔记目录指向仓库之外，已停止导入。');
  }
}

async function uniquePath(vault, wanted) {
  const ext = path.posix.extname(wanted);
  const stem = wanted.slice(0, -ext.length);
  let candidate = wanted;
  for (let n = 2; await vault.adapter.exists(candidate); n++) candidate = `${stem} - ${n}${ext}`;
  return candidate;
}

async function loadCompleted(appDir, taskId) {
  const resultsDir = path.join(appDir, 'note_results');
  let status;
  try { status = JSON.parse(await fs.readFile(path.join(resultsDir, `${taskId}.status.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (status.status !== 'SUCCESS') return null;
  const resultPath = path.join(resultsDir, `${taskId}.json`);
  const result = JSON.parse(await fs.readFile(resultPath, 'utf8'));
  if (typeof result.markdown !== 'string' || !result.markdown.trim()) throw new Error('完成的结果没有 Markdown 正文。');
  const meta = result.audio_meta || {};
  const title = String(meta.title || '视频笔记');
  const videoId = String(meta.video_id || taskId.slice(0, 8));
  const platform = String(meta.platform || 'unknown');
  const hash = digest(JSON.stringify([result.markdown, title, videoId, platform]));
  return { taskId, title, videoId, platform, markdown: result.markdown, hash,
    mediaPaths: [meta.file_path, meta.video_path].filter(value => typeof value === 'string') };
}

async function planImages(appDir, markdown) {
  const files = new Map();
  const missing = [];
  const names = new Set();
  let realRoot;
  for (const match of markdown.matchAll(IMAGE)) {
    const url = match[2] || match[3];
    const name = screenshotName(url);
    if (!name || names.has(name)) continue;
    names.add(name);
    try {
      realRoot ||= await fs.realpath(path.join(appDir, 'static', 'screenshots'));
      const file = await fs.realpath(path.join(realRoot, name));
      if (!within(realRoot, file)) throw new Error('截图指向截图目录之外，已停止导入。');
      const bytes = await fs.readFile(file);
      if (!bytes.length) { missing.push(name); continue; }
      files.set(name, { name, sourcePath: file, bytes, hash: digest(bytes) });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.push(name);
    }
  }
  if (missing.length) {
    const error = new Error(`缺少 ${missing.length} 张截图（首张：${missing[0]}）。请在 BiliNote 补齐截图；若原视频无法读取，请重新下载原视频。补齐后再次导入，或开启自动同步后重试。`);
    error.code = 'BILINOTE_MISSING_IMAGES';
    error.missingImages = missing;
    throw error;
  }
  return files;
}

async function vaultDiskPath(vault, destination) {
  if (typeof vault.adapter.getBasePath !== 'function') {
    const error = new Error('当前仓库不支持本机图片硬链接。');
    error.code = 'ENOTSUP';
    throw error;
  }
  const root = await fs.realpath(vault.adapter.getBasePath());
  const file = path.resolve(root, destination);
  if (!within(root, file)) throw new Error('图片目标不在仓库内。');
  const parent = await fs.realpath(path.dirname(file));
  if (!within(root, parent)) throw new Error('图片目录指向仓库之外。');
  return path.join(parent, path.basename(file));
}

function sameFile(a, b) {
  return a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
}

async function createImage(vault, asset, destination, sharedImages) {
  if (sharedImages) {
    try {
      const target = await vaultDiskPath(vault, destination);
      await fs.link(asset.sourcePath, target);
      if (digest(await fs.readFile(target)) !== asset.hash) {
        await fs.unlink(target);
        const error = new Error('原截图正在变化，已停止导入，请稍后重试。');
        error.code = 'BILINOTE_IMAGE_CHANGED';
        throw error;
      }
      return true;
    } catch (error) {
      // A hard link needs the same filesystem. Keep import usable if a future
      // vault location or filesystem cannot support it; never overwrite files.
      if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS', 'EINVAL'].includes(error.code)) throw error;
    }
  }
  const data = asset.bytes.buffer.slice(asset.bytes.byteOffset, asset.bytes.byteOffset + asset.bytes.byteLength);
  await vault.createBinary(destination, data);
  return false;
}

async function shareExistingImages(vault, settings, isActive = () => true) {
  const folder = validateFolder(settings.folder);
  const appDir = await fs.realpath(settings.sourceDir);
  const screenshotRoot = await fs.realpath(path.join(appDir, 'static', 'screenshots'));
  const assetRoot = `${folder}/附件`;
  const summary = { linked: 0, alreadyShared: 0, skipped: 0, bytesReleased: 0, errors: [] };
  if (!await vault.adapter.exists(assetRoot)) return summary;
  const root = await vaultDiskPath(vault, `${assetRoot}/placeholder`);
  for (const task of await fs.readdir(path.dirname(root), { withFileTypes: true })) {
    if (!task.isDirectory() || !RESULT_NAME.test(`${task.name}.json`)) continue;
    const taskDir = `${assetRoot}/${task.name}`;
    const taskDisk = path.dirname(await vaultDiskPath(vault, `${taskDir}/placeholder`));
    for (const item of await fs.readdir(taskDisk, { withFileTypes: true })) {
      if (!isActive()) return summary;
      const match = item.isFile() && item.name.match(/^(.*)-([0-9a-f]{12})(?: - \d+)?(\.(?:png|jpe?g|webp|gif|avif))$/i);
      if (!match) continue;
      let target, temporary, backup, moved = false, installed = false;
      try {
        const originalName = screenshotName(`/static/screenshots/${match[1]}${match[3]}`);
        const source = await fs.realpath(path.join(screenshotRoot, originalName));
        if (!within(screenshotRoot, source)) throw new Error('原图指向截图目录之外。');
        target = await vaultDiskPath(vault, `${taskDir}/${item.name}`);
        const [sourceStat, targetStat] = await Promise.all([fs.stat(source, { bigint: true }), fs.lstat(target, { bigint: true })]);
        if (!targetStat.isFile() || targetStat.isSymbolicLink()) { summary.skipped++; continue; }
        if (sameFile(sourceStat, targetStat)) { summary.alreadyShared++; continue; }
        const [sourceBytes, targetBytes] = await Promise.all([fs.readFile(source), fs.readFile(target)]);
        const hash = digest(sourceBytes);
        if (hash !== digest(targetBytes) || !hash.startsWith(match[2])) { summary.skipped++; continue; }
        const suffix = crypto.randomUUID();
        temporary = `${target}.shared-${suffix}`;
        backup = `${target}.copy-${suffix}`;
        await fs.link(source, temporary);
        // Keep the old copy until the replacement is installed and verified.
        await fs.rename(target, backup);
        moved = true;
        await fs.rename(temporary, target);
        installed = true;
        const linkedStat = await fs.stat(target, { bigint: true });
        if (!sameFile(sourceStat, linkedStat) || digest(await fs.readFile(target)) !== hash) {
          throw new Error('图片硬链接核对失败。');
        }
        await fs.unlink(backup);
        moved = false;
        summary.linked++;
        summary.bytesReleased += targetBytes.length;
      } catch (error) {
        try {
          if (moved) {
            if (installed) await fs.unlink(target);
            await fs.rename(backup, target);
          }
          if (temporary) await fs.unlink(temporary).catch(cleanup => { if (cleanup.code !== 'ENOENT') throw cleanup; });
        } catch (restoreError) {
          summary.errors.push({ image: item.name, message: `原副本保留在 ${backup}；恢复失败：${restoreError.message}` });
        }
        summary.errors.push({ image: item.name, message: error.message || String(error) });
      }
    }
  }
  return summary;
}

async function importNote(vault, appDir, folder, note, isActive = () => true, sharedImages = true) {
  // Validate all referenced local pictures before creating the note, so an incomplete
  // BiliNote write is retried rather than exported with broken image links.
  const images = await planImages(appDir, note.markdown);
  if (!isActive()) throw new Error('同步已停止。');
  await ensureFolder(vault, folder);
  const wanted = `${folder}/${safeName(note.title)} - ${safeName(note.videoId)}.md`;
  const notePath = await uniquePath(vault, wanted);
  const assetFolder = `${folder}/附件/${note.taskId}`;
  if (images.size) await ensureFolder(vault, assetFolder);
  let linkedImages = 0;
  for (const asset of images.values()) {
    if (!isActive()) throw new Error('同步已停止。');
    const ext = path.posix.extname(asset.name);
    const stem = asset.name.slice(0, -ext.length);
    let destination = `${assetFolder}/${stem}-${asset.hash.slice(0, 12)}${ext}`;
    if (await vault.adapter.exists(destination)) {
      const existing = await vault.adapter.readBinary(destination);
      if (digest(Buffer.from(existing)) !== asset.hash) destination = await uniquePath(vault, destination);
    }
    if (!await vault.adapter.exists(destination)) {
      if (await createImage(vault, asset, destination, sharedImages)) linkedImages++;
    } else if (sharedImages && typeof vault.adapter.getBasePath === 'function') {
      const [sourceStat, destinationStat] = await Promise.all([
        fs.stat(asset.sourcePath, { bigint: true }), fs.stat(await vaultDiskPath(vault, destination), { bigint: true }),
      ]);
      if (sameFile(sourceStat, destinationStat)) linkedImages++;
    }
    asset.relative = path.posix.relative(path.posix.dirname(notePath), destination).split('/').map(encodeURIComponent).join('/');
  }
  const markdown = note.markdown.replace(IMAGE, (full, alt, angled, bare, title) => {
    const name = screenshotName(angled || bare);
    const asset = name && images.get(name);
    return asset ? `![${alt}](<${asset.relative}>${title ? ` ${title}` : ''})` : full;
  });
  const importedAt = new Date().toISOString();
  const properties = {
    source: 'BiliNote',
    bilinote_task: note.taskId,
    bilinote_source_hash: note.hash,
    video_id: note.videoId,
    platform: note.platform,
    bilinote_image_count: images.size,
    imported_at: importedAt,
  };
  const header = Object.entries(properties).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
  if (!isActive()) throw new Error('同步已停止。');
  await vault.create(notePath, `---\n${header}\n---\n\n${markdown.trim()}\n`);
  return { path: notePath, images: images.size, linkedImages, hash: note.hash, importedAt };
}

function readReceipt(text, note, filePath) {
  const header = text.slice(0, 5000).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!header) return null;
  const value = key => {
    const raw = header.match(new RegExp(`^${key}:\\s*(.*?)\\s*$`, 'm'))?.[1];
    if (!raw) return '';
    try { return JSON.parse(raw); }
    catch { return raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : raw.replace(/\s+#.*$/, ''); }
  };
  if (value('bilinote_task') !== note.taskId || value('bilinote_source_hash') !== note.hash) return null;
  return { path: filePath, hash: note.hash, images: Number(value('bilinote_image_count')) || 0, importedAt: value('imported_at') || '' };
}

async function recoverImport(vault, folder, note, searchAll = false) {
  // The note's own metadata is a durable receipt if Obsidian closed between
  // creating the note and saving plugin state. Personal edits remain untouched.
  for (const file of vault.getMarkdownFiles().filter(item => searchAll || item.path.startsWith(`${folder}/`))) {
    const receipt = readReceipt(await vault.read(file), note, file.path);
    if (receipt) return receipt;
  }
  return null;
}

async function savedImport(vault, folder, note, receipt) {
  if (receipt?.hash === note.hash && typeof receipt.path === 'string' &&
      !path.posix.isAbsolute(receipt.path) && !receipt.path.includes('\\') && !/^[A-Za-z]:/.test(receipt.path) &&
      path.posix.normalize(receipt.path) === receipt.path && !receipt.path.startsWith('../') &&
      await vault.adapter.exists(receipt.path)) {
    const file = vault.getAbstractFileByPath?.(receipt.path);
    if (file) {
      const saved = readReceipt(await vault.read(file), note, receipt.path);
      if (saved) return saved;
    }
  }
  return recoverImport(vault, folder, note, !!receipt);
}

async function rememberImport(imports, key, record, save) {
  const previous = imports[key];
  imports[key] = record;
  try { await save(); }
  catch (error) {
    if (previous) imports[key] = previous;
    else delete imports[key];
    throw error;
  }
}

function emptyCleanup() { return { deleted: [], bytesFreed: 0, candidates: [], pending: [], errors: [] }; }
function equalPath(a, b) { return pathKey(path.resolve(a)) === pathKey(path.resolve(b)); }

async function hasActiveTasks(resultsDir) {
  for (const entry of await fs.readdir(resultsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !TASK_STATUS_NAME.test(entry.name)) continue;
    const state = JSON.parse(await fs.readFile(path.join(resultsDir, entry.name), 'utf8'));
    if (!['SUCCESS', 'FAILED', 'ERROR', 'CANCELLED', 'CANCELED'].includes(state.status)) return true;
  }
  return false;
}

async function verifySavedNote(vault, appDir, folder, note, record) {
  if (!record || record.hash !== note.hash || typeof record.path !== 'string' ||
      !record.path.startsWith(`${folder}/`) || path.posix.normalize(record.path) !== record.path ||
      !await vault.adapter.exists(record.path)) throw new Error('笔记尚未可靠保存到 Obsidian。');
  const file = vault.getAbstractFileByPath(record.path);
  if (!file) throw new Error('Obsidian 尚未识别已保存的笔记。');
  const text = await vault.read(file);
  if (!readReceipt(text, note, record.path)) throw new Error('笔记保存记录不匹配。');
  const assets = await planImages(appDir, note.markdown);
  const remaining = new Set(assets.keys());
  for (const match of text.matchAll(IMAGE)) {
    const url = match[2] || match[3];
    if (/^(?:[a-z]+:|\/|\\)/i.test(url)) continue;
    let relative;
    try { relative = decodeURIComponent(url); } catch { continue; }
    const basename = path.posix.basename(relative);
    const asset = [...assets.values()].find(item => {
      const ext = path.posix.extname(item.name);
      const stem = item.name.slice(0, -ext.length);
      const prefix = `${stem}-${item.hash.slice(0, 12)}`;
      return basename === `${prefix}${ext}` ||
        (basename.startsWith(`${prefix} - `) && /^\d+$/.test(basename.slice(prefix.length + 3, -ext.length)) && basename.endsWith(ext));
    });
    if (!asset) continue;
    const destination = path.posix.normalize(path.posix.join(path.posix.dirname(record.path), relative));
    if (destination.startsWith('../') || destination === '..' || path.posix.isAbsolute(destination)) throw new Error('笔记图片不在仓库内。');
    // Validate the actual on-disk target, including its parent, before reading it.
    const disk = await vaultDiskPath(vault, destination);
    const stat = await fs.lstat(disk);
    if (!stat.isFile() || stat.isSymbolicLink() || digest(await fs.readFile(disk)) !== asset.hash) throw new Error('已同步图片内容不完整。');
    remaining.delete(asset.name);
  }
  if (remaining.size) throw new Error(`已保存笔记有 ${remaining.size} 张截图未核对成功。`);
}

async function cleanupCompletedMedia({ vault, settings, imports, isActive = () => true, dryRun = false, graceMs = 30000, taskIds = null }) {
  const summary = emptyCleanup();
  const folder = validateFolder(settings.folder);
  const appDir = await fs.realpath(settings.sourceDir);
  const resultsDir = path.join(appDir, 'note_results');
  const dataDir = path.resolve(appDir, 'data');
  let dataStat;
  try { dataStat = await fs.lstat(dataDir); }
  catch (error) { if (error.code === 'ENOENT') return summary; throw error; }
  // Never follow a redirected cache directory or recursively scan user uploads.
  if (!within(appDir, dataDir) || !dataStat.isDirectory() || dataStat.isSymbolicLink() ||
      !equalPath(await fs.realpath(dataDir), dataDir)) throw new Error('下载目录不是 BiliNote 内的普通 data 文件夹，已停止清理。');
  if (await hasActiveTasks(resultsDir)) {
    summary.pending.push({ reason: 'BiliNote 仍有任务正在生成，音视频清理将等待任务结束。' });
    return summary;
  }
  const groups = new Map();
  for (const entry of await fs.readdir(resultsDir, { withFileTypes: true })) {
    const match = entry.isFile() && entry.name.match(RESULT_NAME);
    if (!match) continue;
    const note = await loadCompleted(appDir, match[1]);
    if (!note) continue;
    if (!/^[a-z0-9_-]{1,128}$/i.test(note.videoId)) {
      summary.pending.push({ taskId: note.taskId, reason: '无法确定对应下载文件，已保留音视频。' });
      continue;
    }
    if (!groups.has(pathKey(note.videoId))) groups.set(pathKey(note.videoId), []);
    groups.get(pathKey(note.videoId)).push(note);
  }
  const entries = await fs.readdir(dataDir, { withFileTypes: true });
  const used = new Set();
  const selected = taskIds === null ? null : new Set(taskIds);
  for (const [videoId, notes] of groups) {
    if (selected && !notes.some(note => selected.has(note.taskId))) continue;
    // A metadata path alone is not proof of ownership: it can name another
    // video's download or a user upload. Only the exact video ID is eligible.
    const candidates = entries.filter(entry => entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) &&
      pathKey(path.basename(entry.name, path.extname(entry.name))) === videoId);
    if (!candidates.length) continue;
    try {
      for (const note of notes) {
        const key = importKey(appDir, folder, note.taskId);
        await verifySavedNote(vault, appDir, folder, note, imports[key]);
      }
    } catch (error) {
      summary.pending.push({ videoId, reason: error.message || String(error) });
      continue;
    }
    for (const candidate of candidates) {
      if (!isActive()) return summary;
      const target = path.resolve(dataDir, candidate.name);
      if (used.has(pathKey(target))) continue;
      used.add(pathKey(target));
      try {
        // Resolve and verify the exact absolute deletion target. Only single files
        // directly in data with an audio/video extension can reach unlink.
        if (!within(dataDir, target) || !equalPath(path.dirname(target), dataDir) ||
            !MEDIA_EXTENSIONS.has(path.extname(target).toLowerCase())) throw new Error('音视频清理目标不在下载目录内。');
        const stat = await fs.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink() || !equalPath(await fs.realpath(target), target)) throw new Error('音视频文件类型或路径异常，已保留。');
        if (Date.now() - stat.mtimeMs < graceMs) {
          summary.pending.push({ file: candidate.name, reason: '文件刚被写入，将在稳定 30 秒后清理。' });
          continue;
        }
        const item = { path: target, bytes: stat.size, taskIds: notes.map(note => note.taskId) };
        summary.candidates.push(item);
        if (dryRun) continue;
        if (await hasActiveTasks(resultsDir)) {
          summary.pending.push({ reason: '检测到新生成任务，已暂停音视频清理。' });
          return summary;
        }
        for (const note of notes) {
          const fresh = await loadCompleted(appDir, note.taskId);
          if (!fresh || fresh.hash !== note.hash) throw new Error('源笔记正在变化，已保留音视频。');
        }
        const current = await fs.lstat(target);
        if (!isActive()) return summary;
        const currentDir = await fs.lstat(dataDir);
        if (!currentDir.isDirectory() || currentDir.isSymbolicLink() || !equalPath(await fs.realpath(dataDir), dataDir)) throw new Error('下载目录发生变化，已停止清理。');
        if (!current.isFile() || current.isSymbolicLink() || current.ino !== stat.ino ||
            current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) throw new Error('下载文件正在变化，将稍后重试。');
        await fs.unlink(target);
        summary.deleted.push(item);
        summary.bytesFreed += item.bytes;
      } catch (error) {
        if (error.code !== 'ENOENT') summary.errors.push({ file: candidate.name, message: error.message || String(error) });
      }
    }
  }
  return summary;
}

async function listCompletedNotes({ vault, settings, imports, isActive = () => true }) {
  const folder = validateFolder(settings.folder);
  if (!path.isAbsolute(settings.sourceDir)) throw new Error('BiliNote 安装目录需要填写完整路径。');
  const appDir = await fs.realpath(settings.sourceDir);
  const entries = await fs.readdir(path.join(appDir, 'note_results'), { withFileTypes: true });
  const report = { notes: [], errors: [], context: contextKey(settings) };
  for (const entry of entries) {
    const match = entry.isFile() && entry.name.match(RESULT_NAME);
    if (!match || !isActive()) continue;
    try {
      const note = await loadCompleted(appDir, match[1]);
      if (!note) continue;
      const key = importKey(appDir, folder, note.taskId);
      const receipt = imports[key];
      const saved = await savedImport(vault, folder, note, receipt);
      const stat = await fs.stat(path.join(appDir, 'note_results', entry.name));
      report.notes.push({ taskId: note.taskId, title: note.title, videoId: note.videoId, hash: note.hash,
        state: saved ? 'imported' : receipt?.hash === note.hash ? 'missing' : receipt ? 'updated' : 'new', importedPath: saved?.path || '', updatedAt: stat.mtimeMs });
    } catch (error) {
      report.errors.push({ taskId: match[1], message: error.message || String(error) });
    }
  }
  report.notes.sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title));
  return report;
}

async function syncResults({ vault, settings, imports, save, isActive = () => true, canCleanup = () => true, taskIds = null, cleanupOnly = false }) {
  const folder = validateFolder(settings.folder);
  if (!path.isAbsolute(settings.sourceDir)) throw new Error('BiliNote 安装目录需要填写完整路径。');
  const appDir = await fs.realpath(settings.sourceDir);
  const entries = await fs.readdir(path.join(appDir, 'note_results'), { withFileTypes: true });
  const summary = { imported: [], errors: [], skipped: 0, cleanup: emptyCleanup() };
  const selected = taskIds === null ? null : new Set(taskIds);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const match = entry.isFile() && entry.name.match(RESULT_NAME);
    if (!match || !isActive() || cleanupOnly || (selected && !selected.has(match[1]))) continue;
    const taskId = match[1];
    let note;
    try {
      note = await loadCompleted(appDir, taskId);
      if (!note) continue;
      const key = importKey(appDir, folder, taskId);
      const recovered = await savedImport(vault, folder, note, imports[key]);
      if (recovered) {
        if (imports[key]?.hash !== recovered.hash || imports[key]?.path !== recovered.path) await rememberImport(imports, key, recovered, save);
        summary.skipped++;
        continue;
      }
      // Automatic mode respects deliberate deletion. Restoration is explicit.
      if (selected === null && imports[key]?.hash === note.hash) { summary.skipped++; continue; }
      const imported = await importNote(vault, appDir, folder, note, isActive, settings.sharedImages !== false);
      await rememberImport(imports, key, imported, save);
      summary.imported.push(imported);
    } catch (error) {
      summary.errors.push({ taskId, title: note?.title, code: error.code,
        missingImages: error.missingImages,
        message: `${note ? `《${note.title}》：` : ''}${error.message || String(error)}` });
    }
  }
  if (settings.autoCleanup && isActive() && canCleanup()) {
    try { summary.cleanup = await cleanupCompletedMedia({ vault, settings, imports, isActive: () => isActive() && canCleanup(), taskIds }); }
    catch (error) { summary.cleanup.errors.push({ message: error.message || String(error) }); }
  }
  return summary;
}

class NoteImportPicker extends Modal {
  constructor(plugin, report) {
    super(plugin.app);
    this.plugin = plugin;
    this.report = report;
    this.selected = new Set();
    this.query = '';
    this.busy = false;
  }
  onOpen() {
    this.titleEl.setText('选择导入 BiliNote 笔记');
    this.contentEl.addClass('bilinote-import-picker');
    this.contentEl.createEl('p', { text: '勾选你想放进 Obsidian 的笔记，再点击“导入选中”。开始导入前，关闭窗口或点击“暂不导入”不会导入。' });
    const search = this.contentEl.createEl('input', { attr: { type: 'search', placeholder: '搜索标题或视频编号', 'aria-label': '搜索 BiliNote 笔记' } });
    search.addClass('bilinote-import-search');
    search.addEventListener('input', () => { this.query = search.value.trim().toLowerCase(); this.renderRows(); });
    const tools = this.contentEl.createDiv({ cls: 'bilinote-import-actions' });
    const all = tools.createEl('button', { text: '全选当前列表' });
    all.addEventListener('click', () => {
      if (this.busy) return;
      for (const note of this.visibleNotes()) if (note.state !== 'imported') this.selected.add(note.taskId);
      this.renderRows();
    });
    const clear = tools.createEl('button', { text: '取消选择' });
    clear.addEventListener('click', () => { if (!this.busy) { this.selected.clear(); this.renderRows(); } });
    this.rowsEl = this.contentEl.createDiv({ cls: 'bilinote-import-list' });
    this.statusEl = this.contentEl.createEl('p', { cls: 'bilinote-import-status' });
    if (this.report.errors.length) this.contentEl.createEl('p', { text: `${this.report.errors.length} 个结果暂时无法读取，稍后可重新打开此窗口检查。` });
    const footer = this.contentEl.createDiv({ cls: 'bilinote-import-actions' });
    this.cancelButton = footer.createEl('button', { text: '暂不导入' });
    this.cancelButton.addEventListener('click', () => this.close());
    this.importButton = footer.createEl('button', { text: '导入选中', cls: 'mod-cta' });
    this.importButton.addEventListener('click', () => this.importSelected());
    this.renderRows();
  }
  visibleNotes() {
    return this.report.notes.filter(note => !this.query || `${note.title} ${note.videoId}`.toLowerCase().includes(this.query));
  }
  renderRows() {
    this.rowsEl.empty();
    const visible = this.visibleNotes();
    if (!visible.length) this.rowsEl.createEl('p', { text: this.query ? '没有匹配的笔记。' : '还没有生成成功的 BiliNote 笔记。' });
    for (const note of visible) {
      const row = this.rowsEl.createEl('label', { cls: 'bilinote-import-row' });
      row.dataset.taskId = note.taskId;
      const check = row.createEl('input', { attr: { type: 'checkbox', 'aria-label': `选择导入：${note.title}` } });
      check.checked = this.selected.has(note.taskId);
      check.disabled = this.busy || note.state === 'imported';
      check.addEventListener('change', () => {
        if (check.checked) this.selected.add(note.taskId); else this.selected.delete(note.taskId);
        this.updateStatus();
      });
      const info = row.createDiv({ cls: 'bilinote-import-row-info' });
      info.createDiv({ text: note.title });
      const status = { imported: '已导入', updated: '有新版本，可另存导入', missing: '未找到对应笔记，可重新导入', new: '未导入' }[note.state];
      info.createDiv({ cls: 'bilinote-import-row-meta', text: `${status} · ${note.videoId} · ${new Date(note.updatedAt).toLocaleString()}` });
    }
    this.updateStatus();
  }
  updateStatus() {
    this.statusEl.setText(this.busy ? '正在导入选中的笔记…' : `已选择 ${this.selected.size} 篇；${this.report.notes.filter(note => note.state !== 'imported').length} 篇可导入。`);
    this.importButton.disabled = this.busy || !this.selected.size;
    this.cancelButton.disabled = this.busy;
  }
  async importSelected() {
    if (this.busy || !this.selected.size || this.plugin.closed) return;
    if (this.report.context !== contextKey(this.plugin.settings)) {
      new Notice('导入目录或图片设置已改变，请关闭并重新打开选择窗口，再选择需要的笔记。');
      return;
    }
    this.busy = true;
    this.renderRows();
    try {
      await this.plugin.sync(true, false, [...this.selected]);
      if (this.plugin.closed || this.plugin.picker !== this) return;
      this.report = await this.plugin.listNotes();
      this.selected = new Set(this.report.notes.filter(note => note.state !== 'imported' && this.selected.has(note.taskId)).map(note => note.taskId));
    } catch (error) {
      if (!this.plugin.closed) new Notice(`BiliNote 导入失败：${error.message || error}`);
    } finally {
      this.busy = false;
      if (this.plugin.picker === this) this.renderRows();
    }
  }
  onClose() {
    if (this.plugin.picker === this) this.plugin.picker = null;
    this.contentEl.empty();
  }
}

class SyncSettings extends PluginSettingTab {
  constructor(plugin) { super(plugin.app, plugin); this.plugin = plugin; }
  getSettingDefinitions() {
    const plugin = this.plugin;
    const toggle = (key, name, desc) => ({ name, desc, render: setting => setting.addToggle(input => input.setValue(plugin.settings[key]).onChange(async value => {
      plugin.settings[key] = value; await plugin.persist();
    })) });
    const text = (key, name, desc) => ({ name, desc, render: setting => setting.addText(input => input.setValue(plugin.settings[key]).onChange(async value => {
      plugin.settings[key] = value.trim(); await plugin.persist();
    })) });
    const lastCleanup = plugin.cleanupHistory.at(-1);
    return [
      { name: '选择笔记导入', desc: '默认由你勾选笔记再导入。生成成功和打开 Obsidian 都不会直接写入笔记；新版本另存，保留已有编辑。',
        render: setting => setting.addButton(button => button.setButtonText('选择笔记').setCta().onClick(() => plugin.openPicker())) },
      toggle('autoSync', '自动同步全部笔记', '开启后：Obsidian 运行时每 10 秒自动导入全部新结果，打开仓库时也会补导入。想逐篇选择时保持关闭。'),
      toggle('promptOnStartup', '打开 Obsidian 时提醒选择', '自动同步关闭且有待导入笔记时，打开仓库只显示选择窗口；不勾选或关闭窗口就不导入。'),
      text('sourceDir', 'BiliNote 安装目录', '填写包含 note_results 和 static 文件夹的本机完整路径。'),
      text('folder', '笔记保存目录', '当前 Obsidian 仓库内的普通文件夹。'),
      toggle('sharedImages', '共用图片数据', '优先用硬链接，让 BiliNote 和本机仓库共用图片数据。不支持时使用副本。直接修改共用图片的内容会影响两端。'),
      { name: '合并已有图片副本', desc: '内容与 BiliNote 原图一致时，将已有副本转换为硬链接，释放重复占用。',
        render: setting => setting.addButton(button => button.setButtonText('合并图片').onClick(() => plugin.shareImages())) },
      toggle('autoCleanup', '完成后清理下载音视频', '笔记已保存且截图核对完整后，永久删除对应下载音视频，不经过回收站。保留笔记与图片；重新生成或补截图可能需要重新下载。'),
      { name: '清理已有下载音视频', desc: '只检查已导入的笔记与图片，不导入其他笔记。永久删除符合条件的下载音视频，重新处理时需要再次下载。',
        render: setting => setting.addButton(button => button.setButtonText('立即清理').onClick(() => plugin.sync(true, true))) },
      { name: '最近检查', desc: [
        plugin.lastError ? '上次导入未完成：' + plugin.lastError : plugin.lastRun ? '上次导入检查：' + new Date(plugin.lastRun).toLocaleString() : '等待你选择笔记。',
        lastCleanup ? '最近清理：' + lastCleanup.files.length + ' 个音视频文件，释放 ' + (lastCleanup.bytesFreed / 1000000).toFixed(1) + ' MB。' : '',
        plugin.lastCleanupError ? '音视频待清理：' + plugin.lastCleanupError : '',
      ].filter(Boolean).join(' ') },
    ];
  }
}

class BiliNoteSync extends Plugin {
  async onload() {
    const data = await this.loadData() || {};
    this.settings = { ...DEFAULTS, ...data.settings };
    for (const key of Object.keys(DEFAULTS)) if (typeof this.settings[key] !== typeof DEFAULTS[key]) this.settings[key] = DEFAULTS[key];
    this.imports = data.imports && typeof data.imports === 'object' && !Array.isArray(data.imports) ? data.imports : {};
    this.cleanupHistory = Array.isArray(data.cleanupHistory) ? data.cleanupHistory.filter(item => item && Array.isArray(item.files) && Number.isFinite(item.bytesFreed) && typeof item.at === 'string').slice(-50) : [];
    this.closed = false;
    this.lastError = '';
    this.reportedError = '';
    this.lastCleanupError = '';
    this.addSettingTab(new SyncSettings(this));
    this.addCommand({ id: 'sync-now', name: '选择导入 BiliNote 笔记', callback: () => this.openPicker() });
    this.addRibbonIcon('list-checks', '选择导入 BiliNote 笔记', () => this.openPicker());
    this.addCommand({ id: 'share-images', name: '合并 BiliNote 图片副本', callback: () => this.shareImages() });
    this.addCommand({ id: 'clean-media', name: '清理已完成笔记的下载音视频', callback: () => this.sync(true, true) });
    this.registerInterval(window.setInterval(() => { if (this.settings.autoSync && this.settings.sourceDir) this.sync(false); }, 10000));
    this.app.workspace.onLayoutReady(() => {
      if (this.closed || !this.settings.sourceDir) return;
      if (this.settings.autoSync) this.sync(false);
      else if (this.settings.promptOnStartup) this.openPicker(true);
    });
  }
  onunload() { this.closed = true; this.picker?.close(); }
  async persist() {
    if (this.closed) return;
    const snapshot = JSON.parse(JSON.stringify({ settings: this.settings, imports: this.imports, cleanupHistory: this.cleanupHistory }));
    this.persistQueue = (this.persistQueue || Promise.resolve()).catch(() => {}).then(() => this.closed ? undefined : this.saveData(snapshot));
    await this.persistQueue;
  }
  async listNotes() {
    return listCompletedNotes({ vault: this.app.vault, settings: { ...this.settings }, imports: this.imports, isActive: () => !this.closed });
  }
  async openPicker(onlyIfPending = false) {
    if (this.closed || this.picker) return this.picker;
    if (this.openingPicker) return this.openingPicker;
    this.openingPicker = (async () => {
      try {
        const report = await this.listNotes();
        if (this.closed || (onlyIfPending && !report.notes.some(note => note.state !== 'imported'))) return null;
        this.picker = new NoteImportPicker(this, report);
        this.picker.open();
        return this.picker;
      } catch (error) {
        if (!this.closed) new Notice(`无法读取 BiliNote 笔记列表：${error.message || error}`);
        return null;
      }
    })();
    try { return await this.openingPicker; }
    finally { this.openingPicker = null; }
  }
  async shareImages() {
    if (this.closed) return;
    if (this.sharingImages) return this.sharingImages;
    this.sharingImages = (async () => {
      if (this.inFlight) await this.inFlight;
      try {
        const result = await shareExistingImages(this.app.vault, { ...this.settings }, () => !this.closed);
        if (!this.closed) new Notice(`BiliNote：已合并 ${result.linked} 张图片副本，${result.alreadyShared} 张已共用数据。${result.errors.length ? ` ${result.errors.length} 张未完成。` : ''}`);
        return result;
      } catch (error) {
        if (!this.closed) new Notice(`BiliNote 图片合并失败：${error.message || error}`);
        return { linked: 0, errors: [{ message: error.message || String(error) }] };
      }
    })();
    try { return await this.sharingImages; }
    finally { this.sharingImages = null; }
  }
  async sync(manual = false, forceCleanup = false, taskIds = null) {
    if (this.closed) return;
    if (manual && !forceCleanup && taskIds === null) return this.openPicker();
    if (!manual && !this.settings.autoSync) return;
    const context = contextKey(this.settings);
    if (this.sharingImages) await this.sharingImages;
    if (this.closed) return;
    if (context !== contextKey(this.settings)) return { imported: [], errors: [{ message: '导入设置已改变，请重新选择笔记。' }], skipped: 0, cleanup: emptyCleanup() };
    if (this.inFlight) {
      const result = await this.inFlight;
      if (context !== contextKey(this.settings)) return { imported: [], errors: [{ message: '导入设置已改变，请重新选择笔记。' }], skipped: 0, cleanup: emptyCleanup() };
      return manual && !this.closed ? this.sync(manual, forceCleanup, taskIds) : result;
    }
    this.inFlight = this.runSync(manual, forceCleanup, taskIds);
    try { return await this.inFlight; }
    finally { this.inFlight = null; }
  }
  async runSync(manual, forceCleanup = false, taskIds = null) {
    const context = contextKey(this.settings);
    try {
      const result = await syncResults({ vault: this.app.vault, settings: { ...this.settings, autoCleanup: forceCleanup || this.settings.autoCleanup }, imports: this.imports,
        save: () => this.persist(), isActive: () => !this.closed && context === contextKey(this.settings) && (manual || this.settings.autoSync),
        canCleanup: () => forceCleanup || this.settings.autoCleanup,
        taskIds, cleanupOnly: forceCleanup && taskIds === null });
      this.lastRun = Date.now();
      this.lastError = result.errors.map(item => item.message).join('；');
      this.lastCleanupError = result.cleanup.errors.map(item => item.message).join('；');
      if (result.cleanup.deleted.length) {
        this.cleanupHistory.push({ at: new Date().toISOString(), files: result.cleanup.deleted, bytesFreed: result.cleanup.bytesFreed });
        this.cleanupHistory = this.cleanupHistory.slice(-50);
        await this.persist();
      }
      if (this.closed) return result;
      if (result.imported.length) new Notice(`BiliNote：已同步 ${result.imported.length} 篇笔记和 ${result.imported.reduce((n, item) => n + item.images, 0)} 张截图。`);
      if (result.cleanup.deleted.length) new Notice(`BiliNote：已清理 ${result.cleanup.deleted.length} 个下载音视频，释放 ${(result.cleanup.bytesFreed / 1000000).toFixed(1)} MB。`);
      else if (manual && !this.lastError && !result.imported.length) new Notice(result.cleanup.pending[0]?.reason || 'BiliNote：没有新的已完成笔记或可清理的音视频。');
      if (manual && this.lastCleanupError) new Notice(`BiliNote 音视频待清理：${this.lastCleanupError}`);
      if (this.lastError && (manual || this.lastError !== this.reportedError)) new Notice(`BiliNote 待同步：${this.lastError}`);
      this.reportedError = this.lastError;
      return result;
    } catch (error) {
      this.lastRun = Date.now();
      this.lastError = error.message || String(error);
      if (manual && !this.closed) new Notice(`BiliNote 同步失败：${this.lastError}`);
      return { imported: [], errors: [{ message: this.lastError }], skipped: 0, cleanup: emptyCleanup() };
    }
  }
}

module.exports = BiliNoteSync;
module.exports.testing = { syncResults, listCompletedNotes, DEFAULTS, NoteImportPicker, screenshotName, validateFolder, safeName, shareExistingImages, sameFile, cleanupCompletedMedia };
