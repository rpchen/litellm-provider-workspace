import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { workingRoots, optedRepository, normalizeRoots } from './codebase-memory-client.mjs';
import { run, refresh } from './codebase-memory.mjs';

test('[CBM-LOCAL-IDENTITY] root and subdirectory sessions use nearest opted-in canonical Git root', () => {
  const base = path.resolve('.tmp'); mkdirSync(base,{recursive:true});
  const dir = mkdtempSync(path.join(base,'cbm-root-test-'));
  const root = path.join(dir,'workspace'); mkdirSync(root);
  function init(repo, indexed) {
    mkdirSync(repo,{recursive:true}); run('git',['init','-b','main',repo]);
    run('git',['remote','add','origin','https://github.com/example/fixture.git'],{cwd:repo});
    writeFileSync(path.join(repo,'example.ts'),'export function before() { return 1; }');
    if (indexed) { mkdirSync(path.join(repo,'.codebase-memory')); writeFileSync(path.join(repo,'.codebase-memory/artifact.json'),'{"project":"portable-snapshot"}'); }
    run('git',['add','.'],{cwd:repo}); run('git',['-c','user.name=Fixture','-c','user.email=fixture@example.com','commit','-m','fixture'],{cwd:repo});
  }
  try {
    init(root,true); const child = path.join(root,'child'), unindexed = path.join(root,'new');
    init(child,true); init(unindexed,false); mkdirSync(path.join(child,'nested'));
    writeFileSync(path.join(root,'workspace.json'),JSON.stringify({repos:[{name:'child'},{name:'new'},{name:'..'},{name:'../escape'}]}));
    assert.deepEqual(workingRoots(root),[realpathSync(root),realpathSync(child)]);
    assert.deepEqual(workingRoots(path.join(child,'nested')),[realpathSync(child)]);
    assert.deepEqual(workingRoots(unindexed),[]); assert.equal(optedRepository(unindexed),undefined);
    const message = { id:1,result:{roots:[{uri:pathToFileURL(path.join(child,'nested')).href,name:'child'},{uri:pathToFileURL(unindexed).href}]}};
    assert.equal(normalizeRoots(message).result.roots[0].uri,pathToFileURL(realpathSync(child)).href);
    assert.equal(normalizeRoots(message).result.roots[1].uri,message.result.roots[1].uri);
    let indexArgs;
    const execute = (_command,args) => {
      if (args[0]==='--version') return '0.11.0';
      if (args.includes('index_repository')) { indexArgs=args; return '{"structuredContent":{"status":"indexed","project":"native-root"}}'; }
      return '{"structuredContent":{"status":"ready","nodes":2}}';
    };
    refresh(optedRepository(child),{execute,binary:'fixture'});
    assert.ok(!indexArgs.includes('--name'));
    assert.equal(indexArgs[indexArgs.indexOf('--repo-path')+1],realpathSync(child));
  } finally {
    if (!dir.startsWith(base+path.sep)) throw new Error('Unsafe test cleanup');
    rmSync(dir,{recursive:true,force:true});
  }
});
