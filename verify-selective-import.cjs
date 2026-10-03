const fs = require('node:fs/promises'), native = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
class Element {
  constructor(tag='div', options={}) { this.tag=tag; this.options=options; this.children=[]; this.dataset={}; this.events={}; this.value=''; this.checked=false; this.disabled=false; }
  createEl(tag,options={}) { const el=new Element(tag,options);this.children.push(el);return el; }
  createDiv(options={}) { return this.createEl('div',options); }
  addClass() {} setText(text){this.text=text;} empty(){this.children=[];}
  addEventListener(event,fn){this.events[event]=fn;}
  inputs(){return this.children.flatMap(c=>[...(c.tag==='input'?[c]:[]),...c.inputs()]);}
}
let store;
class Plugin {
  constructor(app){this.app=app;this.commands=[];this.intervals=[];}
  async loadData(){return store;}
  async saveData(value){store=JSON.parse(JSON.stringify(value));}
  addSettingTab(){} addCommand(c){this.commands.push(c);} addRibbonIcon(){} registerInterval(fn){this.intervals.push(fn);}
}
class Modal {
  constructor(app){this.app=app;this.titleEl=new Element();this.contentEl=new Element();}
  open(){this.onOpen();} close(){this.onClose();}
}
const context={require:n=>n==='obsidian'?{Plugin,Modal,PluginSettingTab:class{},Setting:class{},Notice:class{}}:require(n),module:{exports:{}},Buffer,process,window:{setInterval:fn=>fn}};
vm.runInNewContext(native.readFileSync(path.join(__dirname,'main.js'),'utf8'),context);
const BiliNoteSync=context.module.exports, {syncResults,listCompletedNotes,DEFAULTS}=BiliNoteSync.testing;
async function main(){
  assert.equal(DEFAULTS.autoSync,false);
  const root=await fs.mkdtemp(path.join(__dirname,'selective-test-')),appDir=path.join(root,'app'),vaultDir=path.join(root,'vault');
  await fs.mkdir(path.join(appDir,'note_results'),{recursive:true}); await fs.mkdir(path.join(appDir,'static/screenshots'),{recursive:true}); await fs.mkdir(path.join(appDir,'data'));await fs.mkdir(vaultDir);
  const target=name=>{const p=path.resolve(vaultDir,name);assert.ok(p.startsWith(vaultDir+path.sep));return p;};
  const files=()=>native.readdirSync(vaultDir,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()&&e.name.endsWith('.md')).map(e=>({path:path.relative(vaultDir,path.join(e.parentPath,e.name)).replace(/\\/g,'/')}));
  const vault={getMarkdownFiles:files,getAbstractFileByPath:name=>native.existsSync(target(name))?{path:name}:null,read:f=>fs.readFile(target(f.path),'utf8'),adapter:{getBasePath:()=>vaultDir,exists:async n=>native.existsSync(target(n)),readBinary:n=>fs.readFile(target(n))},createFolder:n=>fs.mkdir(target(n)),createBinary:(n,b)=>fs.writeFile(target(n),Buffer.from(b),{flag:'wx'}),create:(n,t)=>fs.writeFile(target(n),t,{flag:'wx'})};
  const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
  async function result(n,status='SUCCESS'){
    await fs.writeFile(path.join(appDir,'note_results',id(n)+'.status.json'),JSON.stringify({status}));
    await fs.writeFile(path.join(appDir,'note_results',id(n)+'.json'),JSON.stringify({markdown:'# 教程 '+n+(n===1?'\n![](/static/screenshots/one.png)':''),audio_meta:{title:'教程 '+n,video_id:'BVtest'+n,platform:'bilibili',file_path:path.join(appDir,'data','BVtest'+n+'.mp4')}}));
  }
  await fs.writeFile(path.join(appDir,'static/screenshots/one.png'),Buffer.from('screenshot-fixture'));
  await result(1);await result(2);await result(3,'SUMMARIZING');
  for(const n of [1,2]){const p=path.join(appDir,'data','BVtest'+n+'.mp4');await fs.writeFile(p,'cached-video-'+n);await fs.utimes(p,new Date(Date.now()-60000),new Date(Date.now()-60000));}
  store={settings:{sourceDir:appDir,folder:'笔记',autoSync:false,promptOnStartup:true,autoCleanup:true,sharedImages:true},imports:{},cleanupHistory:[]};
  const app={vault,workspace:{onLayoutReady:fn=>{app.startup=fn;}}};
  const plugin=new BiliNoteSync(app);await plugin.onload();
  const report=await listCompletedNotes({vault,settings:plugin.settings,imports:plugin.imports});
  assert.equal(report.notes.length,2);assert.equal(files().length,0);assert.equal(Object.keys(plugin.imports).length,0);
  app.startup();await plugin.openingPicker;
  assert.ok(plugin.picker);assert.equal(plugin.picker.selected.size,0);assert.equal(plugin.picker.importButton.disabled,true);
  plugin.intervals[0]();await plugin.sync(false);
  assert.equal(files().length,0,'startup reminder and automatic-off poll never import');
  await plugin.picker.importSelected();assert.equal(files().length,0,'empty selection never imports');
  plugin.picker.close();assert.equal(files().length,0,'closing the picker changes no notes');
  await result(3,'FAILED'); // Cache cleanup must wait until every generation task is terminal.
  await plugin.openPicker();
  const row=plugin.picker.rowsEl.children.find(r=>r.dataset.taskId===id(1));const check=row.inputs()[0];check.checked=true;check.events.change();
  assert.equal(plugin.picker.selected.size,1);
  await plugin.picker.importSelected();
  assert.equal(files().length,1);assert.ok(files()[0].path.includes('教程 1'));
  assert.equal(plugin.picker.selected.size,0,'imported selection clears');
  assert.ok(!native.existsSync(path.join(appDir,'data/BVtest1.mp4')),'selected successful import can clean its verified cache');
  assert.ok(native.existsSync(path.join(appDir,'data/BVtest2.mp4')),'unselected video cache is untouched');
  const noteText=await vault.read(files()[0]),image=noteText.match(/!\[\]\(<([^>]+)>\)/)[1];
  assert.equal((await fs.stat(path.join(appDir,'static/screenshots/one.png'),{bigint:true})).ino,(await fs.stat(target(path.posix.join('笔记',decodeURIComponent(image))),{bigint:true})).ino,'selected screenshots retain hard-link sharing');
  const after=await plugin.listNotes();assert.equal(after.notes.find(n=>n.taskId===id(1)).state,'imported');assert.equal(after.notes.find(n=>n.taskId===id(2)).state,'new');
  await plugin.sync(true,false,[]);assert.equal(files().length,1,'empty explicit selection is not import-all');
  await plugin.sync(true,true);assert.equal(files().length,1,'cleanup command does not import unselected notes');
  assert.ok(native.existsSync(path.join(appDir,'data/BVtest2.mp4')));
  plugin.onunload();const reopened=new BiliNoteSync(app);await reopened.onload();app.startup();await reopened.openingPicker;
  assert.equal(reopened.settings.autoSync,false);assert.equal(files().length,1);assert.equal(reopened.picker.selected.size,0);
  reopened.picker.close();
  await result(4);await result(5);
  const save=reopened.persist.bind(reopened);
  reopened.settings.autoSync=true;
  reopened.persist=async()=>{reopened.settings.autoSync=false;await save();};
  const automatic=await reopened.sync(false);
  assert.equal(automatic.imported.length,1,'turning automatic sync off during a run stops subsequent imports');
  assert.equal(files().length,2);assert.ok(!files().some(f=>f.path.includes('教程 4')||f.path.includes('教程 5')));
  assert.equal(store.settings.autoSync,false);
  reopened.onunload();
  console.log('PASS: scan is read-only; startup/poll with automatic sync off; empty and cancelled selection; one selected note only; scoped cache cleanup; shared screenshots; no hidden imports by cleanup; settings survive reload; disabling automatic sync stops the batch.');
  console.log('Fixture retained at: '+root);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
