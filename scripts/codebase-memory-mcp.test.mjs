import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { binaryPath, run, toolData } from './codebase-memory.mjs';
import { startSession } from './codebase-memory-session.mjs';

const binary = binaryPath();
const text = result => result.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n') ?? '';
const call = (session,name,args={}) => session.request('tools/call',{name,arguments:args});
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));

test('[CBM-WATCH] cloned roots, nested cwd and independent workspace children update through a real persistent MCP session', {timeout:360000}, async () => {
  assert.ok(run(binary,['--version']).includes('0.11.0'));
  if (process.env.CI) {
    run(binary,['config','set','auto_index','false']);
    run(binary,['config','set','auto_watch','true']);
  }
  assert.equal(run(binary,['config','get','auto_index']),'false');
  assert.equal(run(binary,['config','get','auto_watch']),'true');
  const base = path.resolve('.tmp'); mkdirSync(base,{recursive:true});
  const dir = mkdtempSync(path.join(base,'cbm-real-mcp-'));
  const source = path.join(dir,'source'); mkdirSync(source);
  const portable = `portable-${path.basename(dir)}`;
  const projects = new Set([portable]);
  let session;
  try {
    run('git',['init','-b','main',source]);
    mkdirSync(path.join(source,'.codebase-memory'));
    writeFileSync(path.join(source,'.codebase-memory/artifact.json'),JSON.stringify({schema_version:2,project:portable}));
    writeFileSync(path.join(source,'example.ts'),'export function beforeChange() { return 1; }\n');
    run('git',['add','.'],{cwd:source});
    run('git',['-c','user.name=Fixture','-c','user.email=fixture@example.com','commit','-m','fixture'],{cwd:source});
    const indexed = toolData(JSON.parse(run(binary,['cli','--quiet','--json','index_repository','--repo-path',source,'--name',portable,'--mode','full','--persistence','true'],{cwd:source})));
    assert.equal(indexed.status,'indexed'); projects.add(indexed.project);
    run('git',['add','.codebase-memory'],{cwd:source});
    run('git',['-c','user.name=Fixture','-c','user.email=fixture@example.com','commit','-m','snapshot'],{cwd:source});
    for (const mode of ['root','nested','workspace-child']) {
      const clone = path.join(dir,`new-path-${mode}`);
      run('git',['clone','--quiet',source,clone]);
      run('git',['remote','set-url','origin','https://github.com/example/cbm-fixture.git'],{cwd:clone});
      let target = clone;
      if (mode === 'workspace-child') {
        target = path.join(clone,'child');
        run('git',['clone','--quiet',source,target]);
        run('git',['remote','set-url','origin','https://github.com/example/cbm-child-fixture.git'],{cwd:target});
        writeFileSync(path.join(clone,'.gitignore'),'/child/\n');
        writeFileSync(path.join(clone,'workspace.json'),JSON.stringify({repos:[{name:'child'}]}));
      }
      const cwd = mode === 'nested'?path.join(clone,'nested'):clone; mkdirSync(cwd,{recursive:true});
      session = await startSession(cwd,{timeout:90000});
      projects.add(JSON.parse(readFileSync(path.join(clone,'.codebase-memory/artifact.json'),'utf8')).project);
      // The wrapper hands the handshake back immediately while the startup
      // preparation still runs in the background; the working graph for the
      // clone only exists once that refresh rewrote the artifact marker.
      // Wait for the preparation outcome instead of racing it.
      const preparedProject = await (async () => {
        const deadline = Date.now()+90000;
        for (;;) {
          const localProject = JSON.parse(readFileSync(path.join(target,'.codebase-memory/artifact.json'),'utf8')).project;
          if (localProject !== portable) return localProject;
          assert.ok(Date.now()<deadline,'startup preparation did not register the clone working graph');
          await pause(1000);
        }
      })();
      projects.add(preparedProject);
      const statusResult = await call(session,'index_status',{project:preparedProject,format:'json'});
      assert.equal(statusResult.isError,false,text(statusResult));
      const status = toolData(statusResult);
      projects.add(status.project);
      assert.equal(status.status,'ready'); assert.notEqual(status.project,portable);
      assert.equal(path.resolve(status.root_path),path.resolve(target));
      const search = ()=>call(session,'search_graph',{project:preparedProject,label:'Function',name_pattern:'(beforeChange|afterChange)',limit:10});
      assert.match(text(await search()),/beforeChange/);
      writeFileSync(path.join(target,'example.ts'),'export function afterChange() { return 2; }\n');
      const deadline = Date.now()+60000;
      let found;
      do { await pause(1000); found=text(await search()); } while (!found.includes('afterChange') && Date.now()<deadline);
      assert.match(found,/afterChange/,'watcher sees new symbol without restarting or manual indexing');
      assert.ok(!found.includes('beforeChange'),'watcher removes old symbol');
      assert.equal(JSON.parse(readFileSync(path.join(target,'.codebase-memory/artifact.json'),'utf8')).project,status.project);
      await call(session,'delete_project',{project:status.project}); projects.delete(status.project);
      session.close(); session=undefined;
    }
  } finally {
    session?.close();
    for (const project of projects) { try { run(binary,['cli','--quiet','--json','delete_project','--project',project]); } catch {} }
    if (!dir.startsWith(base+path.sep)) throw new Error('Unsafe native fixture cleanup');
    rmSync(dir,{recursive:true,force:true});
  }
});
