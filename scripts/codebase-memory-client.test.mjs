import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { workingRoots, optedRepository, normalizeRoots, prepareTask, ReadinessGate } from './codebase-memory-client.mjs';
import { run, refresh } from './codebase-memory.mjs';
import { binaryPath } from './codebase-memory.mjs';
import { startSession } from './codebase-memory-session.mjs';

const nativeProjectName = root => root.replaceAll('\\', '/').replace(/[^\w.-]/g, '-').replace(/-+/g, '-');

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
    rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});

function selectedFixture() {
  const base = path.resolve('.tmp'); mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'cbm-selected-'));
  function init(root, project) {
    mkdirSync(root, { recursive: true }); run('git', ['init', '-b', 'main', root]);
    run('git', ['remote', 'add', 'origin', `https://github.com/example/${project}.git`], { cwd: root });
    mkdirSync(path.join(root, '.codebase-memory'));
    writeFileSync(path.join(root, '.codebase-memory/selection.json'), JSON.stringify({ schema_version: 1, project, distribution: 'merged-main', index_branch: 'codebase-memory-index' }));
    writeFileSync(path.join(root, '.gitignore'), '.codebase-memory/*\n!.codebase-memory/selection.json\nchild/\n');
    writeFileSync(path.join(root, 'source.ts'), 'export const fixture = true;');
    run('git', ['add', '.'], { cwd: root }); run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'fixture'], { cwd: root });
    const commit = run('git', ['rev-parse', 'HEAD'], { cwd: root });
    writeFileSync(path.join(root, '.codebase-memory/artifact.json'), JSON.stringify({ schema_version: 2, project, commit }));
    return realpathSync(root);
  }
  const root = init(path.join(dir, 'workspace'), 'workspace'), child = init(path.join(root, 'child'), 'child');
  writeFileSync(path.join(root, 'workspace.json'), JSON.stringify({ repos: [{ name: 'child' }] }));
  return { root, child, cleanup() { assert.ok(dir.startsWith(base + path.sep)); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
}
for (const corruption of ['malformed JSON', 'invalid schema', 'wrong project']) {
  test(`[CBM-SELECTED-METADATA] ${corruption} in a selected child blocks the whole workspace`, { timeout: 120000 }, async () => {
    const f = selectedFixture();
    try {
      const value = corruption === 'malformed JSON' ? '{broken' : JSON.stringify({ schema_version: corruption === 'invalid schema' ? 1 : 2, project: corruption === 'wrong project' ? 'not-this-repository-cbm-review' : 'child', commit: run('git', ['rev-parse', 'HEAD'], { cwd: f.child }) });
      writeFileSync(path.join(f.child, '.codebase-memory/artifact.json'), value);
      let called = 0;
      assert.throws(() => workingRoots(f.root), /metadata failed/);
      await assert.rejects(prepareTask(f.root, { prepareRepository: async () => { called++; return { status: 'ready' }; } }), /metadata failed/);
      assert.equal(called, 0); assert.equal(run('git', ['branch', '--show-current'], { cwd: f.child }), 'main');
    } finally { f.cleanup(); }
  });
}
test('[CBM-MISSING-METADATA] selected clone without artifact is still an expected repository and must be restored', async () => {
  const f = selectedFixture();
  try {
    rmSync(path.join(f.child, '.codebase-memory/artifact.json'));
    assert.deepEqual(workingRoots(f.root), [f.root, f.child]);
    const receipts = [];
    const result = await prepareTask(f.root, { prepareRepository: async root => {
      const actual = optedRepository(root); receipts.push(root);
      writeFileSync(path.join(root, '.codebase-memory/artifact.json'), JSON.stringify({ schema_version: 2, project: actual.project, commit: actual.commit }));
      return { status: 'ready', root, project: actual.project, branch: 'main', commit: actual.commit, index_commit: actual.commit };
    } });
    assert.equal(result.status, 'ready'); assert.deepEqual(receipts, [f.root, f.child]);
    rmSync(path.join(f.child, '.codebase-memory/artifact.json'));
    await assert.rejects(prepareTask(f.root, { prepareRepository: async root => { if (root === f.child) throw new Error('Missing selected index cannot be restored'); return { status: 'working', root }; } }), /cannot be restored/);
  } finally { f.cleanup(); }
});
test('[CBM-WORKSPACE-BUDGET] an expired positive budget cannot become an unlimited immediate attempt for another root', async () => {
  const f = selectedFixture();
  try {
    let called = 0;
    await assert.rejects(prepareTask(f.root, { waitMs: 10, prepareRepository: async root => {
      called++; await new Promise(resolve => setTimeout(resolve, 40));
      return { status: 'working', root };
    } }), /timed out/);
    assert.equal(called, 1); assert.equal(run('git', ['branch', '--show-current'], { cwd: f.child }), 'main');
  } finally { f.cleanup(); }
});

test('[CBM-ALL-RECEIPTS] missing, duplicate and forged child receipts cannot declare overall ready', async () => {
  const f = selectedFixture();
  try {
    for (const kind of ['missing root', 'duplicate root', 'wrong branch', 'wrong index SHA', 'wrong marker SHA']) {
      await assert.rejects(prepareTask(f.root, { prepareRepository: async root => {
        const sha = run('git', ['rev-parse', 'HEAD'], { cwd: root });
        if (kind === 'wrong marker SHA') writeFileSync(path.join(root, '.codebase-memory/artifact.json'), JSON.stringify({ schema_version: 2, project: root === f.root ? 'workspace' : 'child', commit: 'f'.repeat(40) }));
        return { status: 'ready', root: kind === 'missing root' ? f.root + '-missing' : kind === 'duplicate root' ? f.root : root,
          project: root === f.root ? 'workspace' : 'child', branch: kind === 'wrong branch' ? 'other' : 'main', commit: sha, index_commit: kind === 'wrong index SHA' ? 'f'.repeat(40) : sha };
      } }), /expected repositories|differs/);
    }
  } finally { f.cleanup(); }
});
test('[CBM-PROJECT-GATE] native project aliases, paths and both compare targets obey the same failed root', async () => {
  const f = selectedFixture();
  try {
    const aliases = new Map([['native-child', f.child], ['child', f.child], [f.child, f.child], [path.join(f.child, 'native.db'), f.child], ['healthy', f.root]]);
    const gate = new ReadinessGate(async value => aliases.get(value), f.child);
    gate.register([{ name: 'search_graph', inputSchema: { properties: { project: { type: 'string' } } } }, { name: 'compare_graphs', inputSchema: { properties: { base_project: { type: 'string' }, target_project: { type: 'string' } } } }]);
    gate.fail([f.child], 'Selected child is not prepared');
    for (const alias of ['native-child', 'child', f.child, path.join(f.child, 'native.db')]) await assert.rejects(gate.check('search_graph', { project: alias }), /not prepared/);
    for (const key of ['project_name', 'project_id', 'projectName']) await assert.rejects(gate.check('search_graph', { [key]: 'child' }), /not prepared/);
    await assert.rejects(gate.check('search_graph', {}), /not prepared/);
    await assert.rejects(gate.check('compare_graphs', { base_project: 'healthy', target_project: f.child }), /not prepared/);
    await assert.rejects(gate.check('compare_graphs', { base_project: 'child', target_project: 'healthy' }), /not prepared/);
    await assert.rejects(gate.check('search_graph', { project: 'unresolvable-alias' }), /cannot be resolved/);
    await gate.check('search_graph', { project: 'healthy' });
    gate.success([{ root: f.child, status: 'legacy' }]); await assert.rejects(gate.check('search_graph', { project: 'child' }), /not prepared/);
    gate.success([{ root: f.child, status: 'ready' }]); await gate.check('compare_graphs', { base_project: 'child', target_project: 'healthy' });
    // A renamed/stale database row can retain a different root while its
    // canonical internal name is still the failed repository's marker name.
    const stale = new ReadinessGate(async () => ({ root: f.root, project: 'child' }), f.root);
    stale.register([{ name: 'search_graph', inputSchema: { properties: { project: {} } } }]); stale.fail([f.child], 'stale database must remain blocked');
    await assert.rejects(stale.check('search_graph', { project: path.join(f.root, 'renamed.db') }), /remain blocked/);
    writeFileSync(path.join(f.child, '.codebase-memory/artifact.json'), '{broken');
    for (const project of [f.child.replaceAll('\\', '/').replace(/[^\w.-]/g, '-').replace(/-+/g, '-'), `child-main-${'a'.repeat(40)}`]) {
      const damaged = new ReadinessGate(async () => ({ root: f.root, project }), f.root);
      damaged.register([{ name: 'search_graph', inputSchema: { properties: { project: {} } } }]); damaged.fail([f.child], 'corrupt metadata cannot release old database');
      await assert.rejects(damaged.check('search_graph', { project: path.join(f.root, 'old.db') }), /cannot release/);
    }
  } finally { f.cleanup(); }
});

test('[CBM-MCP-GATE] actual native registry and stdio enforce aliases, absolute paths and both compare targets after child metadata failure', { timeout: 120000 }, async () => {
  const f = selectedFixture(); let session;
  const indexedProjects = [];
  try {
    // Use the native installation's secure cache, as the existing real MCP
    // watcher suite does. This machine's workspace/Temp ancestors are not
    // trusted native coordination directories; never change their ACLs.
    const env = { ...process.env };
    const execute = (command, args, options) => run(command, args, { ...options, env });
    const status = [];
    for (const root of [f.root, f.child]) {
      // Fail remote fetch immediately on an isolated localhost proxy; never
      // contact GitHub from this failure-path test or read user credentials.
      run('git', ['config', 'http.proxy', 'http://127.0.0.1:1'], { cwd: root });
      status.push(refresh(optedRepository(root), { binary: binaryPath(), execute }));
      indexedProjects.push(status.at(-1).project);
    }
    writeFileSync(path.join(f.child, '.codebase-memory/artifact.json'), '{malformed-selected-child');
    session = await startSession(f.root, { env, timeout: 60000,
      args: [process.env.CBM_REVIEW_CLIENT ?? path.resolve('scripts/codebase-memory-client.mjs')] });
    const registry = await session.request('tools/list');
    assert.ok(registry.tools.find(tool => tool.name === 'compare_graphs').inputSchema.properties.base_project);
    const failed = await session.request('tools/call', { name: 'prepare_codebase_task', arguments: { cwd: f.root, wait_ms: 0 } });
    assert.equal(failed.isError, true);
    const calls = [
      { name: 'search_graph', arguments: { project: status[1].project, query: 'fixture' } },
      { name: 'search_graph', arguments: { project: 'child', query: 'fixture' } },
      { name: 'search_graph', arguments: { project: f.child, query: 'fixture' } },
      { name: 'search_graph', arguments: { project_name: status[1].project, query: 'fixture' } },
      { name: 'compare_graphs', arguments: { base_project: status[0].project, target_project: status[1].project } },
      { name: 'compare_graphs', arguments: { base_project: status[1].project, target_project: status[0].project } }
    ];
    const results = [];
    for (const call of calls) results.push(await session.request('tools/call', call));
    assert.deepEqual(results.map(result => result.isError), calls.map(() => true), JSON.stringify(calls));
    for (let index = 0; index < calls.length; index++) {
      const result = results[index], call = calls[index];
      assert.match(result.content.map(part => part.text ?? '').join('\n'), /metadata failed|preparation.*failed|cannot be resolved/i, JSON.stringify(call));
    }
  } finally {
    session?.close(); await new Promise(resolve => setTimeout(resolve, 500)); f.cleanup();
    for (const project of indexedProjects) run(binaryPath(), ['cli', '--quiet', '--json', 'delete_project', '--project', project]);
  }
});

function legacyFixture() {
  const base = path.resolve('.tmp'); mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'cbm-legacy-'));
  function init(root, project) {
    mkdirSync(root, { recursive: true }); run('git', ['init', '-b', 'main', root]);
    run('git', ['remote', 'add', 'origin', `https://github.com/example/${project}.git`], { cwd: root });
    mkdirSync(path.join(root, '.codebase-memory'));
    writeFileSync(path.join(root, '.gitignore'), '.codebase-memory/*\n');
    writeFileSync(path.join(root, 'source.ts'), 'export const rootsFixture = true;');
    run('git', ['add', '.'], { cwd: root }); run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'fixture'], { cwd: root });
    const commit = run('git', ['rev-parse', 'HEAD'], { cwd: root });
    writeFileSync(path.join(root, '.codebase-memory/artifact.json'), JSON.stringify({ schema_version: 2, project, commit }));
    return realpathSync(root);
  }
  const repo = init(path.join(dir, 'legacy-repo'), 'roots-fixture');
  const generic = path.join(dir, 'generic'); mkdirSync(generic);
  return { repo, generic, project: 'roots-fixture', commit: run('git', ['rev-parse', 'HEAD'], { cwd: repo }),
    cleanup() { assert.ok(dir.startsWith(base + path.sep)); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
}
test('[CBM-ROOTS-DISCOVERY] a generic-cwd session gates and recovers a root reported by the host', { timeout: 180000 }, async () => {
  const f = legacyFixture();
  let session;
  const indexedProjects = [];
  try {
    // Corrupt the selected repository metadata before the host reports the root.
    writeFileSync(path.join(f.repo, '.codebase-memory/artifact.json'), '{broken legacy artifact');
    // Fail remote fetch immediately on an isolated localhost proxy; never
    // contact GitHub from this failure-path test or read user credentials.
    const env = { ...process.env };
    session = await startSession(f.generic, { env, timeout: 90000, args: [process.env.CBM_REVIEW_CLIENT ?? path.resolve('scripts/codebase-memory-client.mjs')] });
    const registry = await session.request('tools/list');
    assert.ok(registry.tools.find(tool => tool.name === 'search_graph').inputSchema.properties.project);
    // The host reports the repository root through a roots/list response.
    // The wrapper must treat the metadata failure as a gated repository, not
    // as a protocol problem, and must not forward the corrupted root.
    session.send({ id: 90001, result: { roots: [{ uri: pathToFileURL(f.repo).href }] } });
    await new Promise(resolve => setTimeout(resolve, 500));
    const calls = [
      { name: 'search_graph', arguments: { project: f.project, query: 'rootsFixture' } },
      { name: 'search_graph', arguments: { project: nativeProjectName(f.repo), query: 'rootsFixture' } },
      { name: 'search_graph', arguments: { project: f.repo, query: 'rootsFixture' } },
      { name: 'search_graph', arguments: { project_name: f.project, query: 'rootsFixture' } },
      { name: 'compare_graphs', arguments: { base_project: f.project, target_project: f.repo } }
    ];
    const results = [];
    for (const call of calls) results.push(await session.request('tools/call', call));
    assert.deepEqual(results.map(result => result.isError), calls.map(() => true), JSON.stringify(calls));
    for (const result of results) assert.match(result.content.map(part => part.text ?? '').join('\n'), /metadata failed|preparation.*failed|cannot be resolved/i);
    // Repair the metadata and re-report the root: the same session must
    // re-prepare the repository, reopen the gate, and serve queries again.
    writeFileSync(path.join(f.repo, '.codebase-memory/artifact.json'), JSON.stringify({ schema_version: 2, project: f.project, commit: f.commit }));
    session.send({ id: 90002, result: { roots: [{ uri: pathToFileURL(f.repo).href }] } });
    // The native working graph is registered under the path-derived name.
    const nativeName = nativeProjectName(f.repo);
    const deadline = Date.now() + 90000; let recovered;
    do {
      await new Promise(resolve => setTimeout(resolve, 1000));
      recovered = await session.request('tools/call', { name: 'search_graph', arguments: { project: nativeName, query: 'rootsFixture' } }).catch(() => undefined);
    } while (recovered?.isError && Date.now() < deadline);
    assert.equal(recovered.isError, false, JSON.stringify(recovered.content));
    indexedProjects.push(nativeName);
  } finally {
    session?.close(); await new Promise(resolve => setTimeout(resolve, 500)); f.cleanup();
    for (const project of indexedProjects) run(binaryPath(), ['cli', '--quiet', '--json', 'delete_project', '--project', project]);
  }
});
test('[CBM-HANDSHAKE-LATENCY] startup preparation never blocks the MCP handshake', { timeout: 120000 }, async () => {
  // The wrapper must answer initialize immediately while the four-repository
  // startup preparation still runs in the background. A client's stdio
  // connection window (30s in Claude Code) is far shorter than a full
  // workspace preparation (40s+ measured on this workspace).
  const f = selectedFixture();
  let session;
  try {
    const began = Date.now();
    session = await startSession(f.root, { timeout: 60000, args: [process.env.CBM_REVIEW_CLIENT ?? path.resolve('scripts/codebase-memory-client.mjs')] });
    const elapsed = Date.now() - began;
    assert.ok(elapsed < 25000, `initialize answered after ${elapsed}ms; preparation must not gate the handshake`);
    const registry = await session.request('tools/list');
    assert.ok(registry.tools.find(tool => tool.name === 'prepare_codebase_task'));
  } finally { session?.close(); await new Promise(resolve => setTimeout(resolve, 500)); f.cleanup(); }
});
