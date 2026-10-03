import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync, linkSync, copyFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { workingRoots, optedRepository, normalizeRoots, prepareTask, ReadinessGate } from './codebase-memory-client.mjs';
import { run, refresh } from './codebase-memory.mjs';
import { binaryPath } from './codebase-memory.mjs';
import { startSession } from './codebase-memory-session.mjs';

const nativeProjectName = root => root.replaceAll('\\', '/').replace(/[^\w.-]/g, '-').replace(/-+/g, '-');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const text = result => result.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? '';
const client = () => process.env.CBM_REVIEW_CLIENT ?? path.resolve('scripts/codebase-memory-client.mjs');
async function endSession(session, timeout = 30000) {
  if (!session) return;
  const exited = new Promise(resolve => session.child.once('exit', resolve));
  if (!session.child.stdin.destroyed) session.child.stdin.end();
  await Promise.race([exited, pause(timeout)]);
  session.close();
}
// Enumerate the fixture's own client subprocesses. The fixture directory name
// is unique per test, so parallel test files can never contribute matches.
function listFixtureProcesses(tag) {
  if (process.platform === 'win32') {
    const script = `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*codebase-memory-client.mjs*' -and $_.CommandLine -like '*${tag}*' } | ForEach-Object { $_.ProcessId }`;
    const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    if (result.error || result.status !== 0) return undefined;
    return result.stdout.trim().split(/\s+/).filter(Boolean).map(Number);
  }
  const result = spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.split('\n').filter(line => line.includes('codebase-memory-client.mjs') && line.includes(tag))
    .map(line => Number(line.trim().split(/\s+/)[0])).filter(Number.isInteger);
}
function initRepo(root, project, origin) {
  mkdirSync(path.join(root, '.codebase-memory'), { recursive: true });
  run('git', ['init', '-b', 'main', root]);
  run('git', ['remote', 'add', 'origin', origin], { cwd: root });
  writeFileSync(path.join(root, '.codebase-memory/selection.json'), JSON.stringify({ schema_version: 1, project, distribution: 'merged-main', index_branch: 'codebase-memory-index' }));
  writeFileSync(path.join(root, '.gitignore'), '.codebase-memory/*\n');
  writeFileSync(path.join(root, 'source.ts'), 'export const fixture = true;\n');
  run('git', ['add', '.'], { cwd: root });
  run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'fixture'], { cwd: root });
  writeFileSync(path.join(root, '.codebase-memory/artifact.json'), JSON.stringify({ schema_version: 2, project, commit: run('git', ['rev-parse', 'HEAD'], { cwd: root }) }));
  return realpathSync(root);
}
// A workspace whose identity scan is deliberately long on every platform: each
// child is a real directory with a `.git` gitfile into one shared repository,
// so the scan performs four real Git reads per child. `realpathSync` keeps
// every candidate distinct and `optedRepository` succeeds for each one.
function slowScanFixture(count) {
  const base = path.resolve('.tmp'); mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'cbm-slow-scan-'));
  const real = path.join(dir, 'real');
  initRepo(real, 'slow-scan-child', 'https://github.com/example/slow-scan-child.git');
  const root = path.join(dir, 'workspace');
  initRepo(root, 'slow-scan-root', 'https://github.com/example/slow-scan-root.git');
  const entries = [];
  for (let index = 0; index < count; index++) {
    const candidate = path.join(root, `child-${index}`);
    mkdirSync(path.join(candidate, '.codebase-memory'), { recursive: true });
    writeFileSync(path.join(candidate, '.git'), `gitdir: ${path.join(real, '.git')}\n`);
    for (const name of ['selection.json', 'artifact.json']) {
      try { linkSync(path.join(real, '.codebase-memory', name), path.join(candidate, '.codebase-memory', name)); }
      catch { copyFileSync(path.join(real, '.codebase-memory', name), path.join(candidate, '.codebase-memory', name)); }
    }
    entries.push({ name: `child-${index}` });
  }
  writeFileSync(path.join(root, 'workspace.json'), JSON.stringify({ repos: entries }));
  return { root, project: 'slow-scan-child', tag: path.basename(dir), cleanup() {
    assert.ok(dir.startsWith(base + path.sep));
    // A just-terminated native daemon can still hold the fixture as its
    // working directory on Windows; bounded whole-tree retries keep cleanup
    // deterministic without changing any assertion.
    for (let attempt = 0; ; attempt++) {
      try { rmSync(dir, { recursive: true, force: true }); return; }
      catch (error) { if (error.code !== 'EPERM' || attempt === 20) throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); }
    }
  } };
}

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
  // The native wrong-project probe briefly holds the fixture as a process
  // working directory on Windows; the release can lag the child's exit by a
  // few seconds. Bounded whole-tree retries keep cleanup deterministic
  // without changing any assertion.
  return { root, child, dir, tag: path.basename(dir), cleanup() {
    assert.ok(dir.startsWith(base + path.sep));
    for (let attempt = 0; ; attempt++) {
      try { rmSync(dir, { recursive: true, force: true }); return; }
      catch (error) { if (error.code !== 'EPERM' || attempt === 20) throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); }
    }
  } };
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
    cleanup() {
      assert.ok(dir.startsWith(base + path.sep));
      for (let attempt = 0; ; attempt++) {
        try { rmSync(dir, { recursive: true, force: true }); return; }
        catch (error) { if (error.code !== 'EPERM' || attempt === 20) throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); }
      }
    } };
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
    // The native working graph is registered under a path-derived name; its
    // exact normalization is native-owned (a POSIX absolute path derives a
    // leading-dash difference), so resolve it through the diagnostic tools
    // the gate always forwards instead of guessing the spelling.
    const nativeName = nativeProjectName(f.repo).replace(/^-+/, '');
    const probe = async () => {
      const payload = result => {
        try { return result?.structuredContent ?? JSON.parse(result?.content?.find(part => part.type === 'text')?.text ?? '{}'); }
        catch { return undefined; }
      };
      for (const candidate of new Set([nativeName, nativeProjectName(f.repo)])) {
        const status = await session.request('tools/call', { name: 'index_status', arguments: { project: candidate, format: 'json' } }).catch(() => undefined);
        const data = payload(status);
        if (!status?.isError && data?.root_path && path.resolve(data.root_path) === path.resolve(f.repo)) return candidate;
      }
      const listed = await session.request('tools/call', { name: 'list_projects', arguments: {} }).catch(() => undefined);
      const data = payload(listed);
      const entry = (data?.projects ?? data?.available_projects ?? []).find(item => (item.project ?? item) && path.resolve((item.root_path ?? '').toString()) === path.resolve(f.repo));
      return entry?.project;
    };
    const deadline = Date.now() + 90000; let recovered, registered;
    do {
      await new Promise(resolve => setTimeout(resolve, 1000));
      registered = await probe();
      if (!registered) continue;
      recovered = await session.request('tools/call', { name: 'search_graph', arguments: { project: registered, query: 'rootsFixture' } }).catch(() => undefined);
    } while ((!registered || recovered?.isError) && Date.now() < deadline);
    assert.ok(registered, 'the recovered working graph must be registered under the reported root');
    assert.equal(recovered.isError, false, JSON.stringify(recovered.content));
    indexedProjects.push(registered);
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

const ghAvailable = (() => { try { return run('gh', ['--version']).startsWith('gh version'); } catch { return false; } })();
test('[CBM-PREPARE-ROUNDS] a late background success cannot clear a newer explicit failure', { timeout: 180000, skip: ghAvailable ? false : 'requires the GitHub CLI for the deterministic hanging sync' }, async () => {
  const f = legacyFixture();
  let session, proxy;
  const sockets = new Set();
  const indexedProjects = [];
  try {
    // Pre-index the legacy root so the daemon already knows its project; the
    // background legacy preparation refreshes the same working graph.
    const env = { ...process.env };
    const status = refresh(optedRepository(f.repo), { binary: binaryPath(), execute: (command, args, options) => run(command, args, { ...options, env }) });
    indexedProjects.push(status.project);
    // A hanging proxy keeps the production GitHub CLI release lookup busy for
    // its full timeout, so the older background success is guaranteed to
    // settle after the newer explicit failure below.
    proxy = createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); }); proxy.unref();
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const sessionEnv = { ...process.env, HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`, https_proxy: `http://127.0.0.1:${proxy.address().port}`, NO_PROXY: '' };
    writeFileSync(path.join(f.repo, 'source.ts'), 'export const rootsFixture = true; // changed after pre-index\n');
    session = await startSession(f.repo, { env: sessionEnv, timeout: 120000, args: [client()] });
    await session.request('tools/list');
    const failed = await session.request('tools/call', { name: 'prepare_codebase_task', arguments: { cwd: f.repo, mode: 'new', wait_ms: 999999 } });
    assert.equal(failed.isError, true, text(failed));
    // The older background round is still in flight. The query waits for its
    // outcome and must then still see the newer explicit failure: a late
    // success may not clear it.
    const gated = await session.request('tools/call', { name: 'search_graph', arguments: { project: status.project, query: 'rootsFixture' } });
    assert.equal(gated.isError, true, JSON.stringify(gated.content));
    assert.match(text(gated), /Invalid task preparation arguments/);
  } finally {
    await endSession(session); await pause(500);
    for (const socket of sockets) socket.destroy();
    proxy?.close();
    for (const project of indexedProjects) { try { run(binaryPath(), ['cli', '--quiet', '--json', 'delete_project', '--project', project]); } catch { /* Native cleanup is best effort. */ } }
    f.cleanup();
  }
});
test('[CBM-LIFECYCLE-EARLY] an early host EOF cancels background work and releases every created session', { timeout: 120000 }, async () => {
  const f = selectedFixture();
  let session;
  const locks = [f.root, f.child].map(root => {
    // Hold both preparations so every worker is still in flight when the host
    // connection closes; a session created after cleanup would keep the
    // wrapper process alive forever.
    const lock = path.join(root, '.git', 'codebase-memory-task.lock');
    mkdirSync(lock); writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'cbm-lifecycle-lock' }));
    return lock;
  });
  try {
    session = await startSession(f.root, { timeout: 60000, args: [client()] });
    const exited = new Promise(resolve => session.child.once('exit', () => resolve(true)));
    session.child.stdin.end();
    const closed = await Promise.race([exited, pause(30000).then(() => false)]);
    assert.ok(closed, 'the wrapper must exit after the host connection closes instead of leaking a late watcher session');
    // No wrapper process for this fixture may still be alive, and none may
    // appear afterwards: the release of a session created after cleanup was
    // exactly the leak this regression guards.
    const surviving = () => listFixtureProcesses(f.tag);
    const left = surviving();
    if (left) assert.deepEqual(left, [], `client processes outlived the host connection: ${JSON.stringify(left)}`);
    await pause(5000);
    const later = surviving();
    if (later) assert.deepEqual(later, [], `a client process started after the host connection closed: ${JSON.stringify(later)}`);
  } finally {
    session?.close(); await pause(500);
    for (const lock of locks) rmSync(lock, { recursive: true, force: true });
    f.cleanup();
  }
});
test('[CBM-LIFECYCLE-NORMAL] a normal host EOF closes established watcher sessions', { timeout: 120000 }, async () => {
  const f = selectedFixture();
  let session;
  try {
    // Fail remote fetches immediately so the preparations settle and the
    // watcher sessions are established before the host connection closes.
    for (const root of [f.root, f.child]) run('git', ['config', 'http.proxy', 'http://127.0.0.1:1'], { cwd: root });
    session = await startSession(f.root, { timeout: 60000, args: [client()] });
    await session.request('tools/list');
    const gated = await session.request('tools/call', { name: 'search_graph', arguments: { project: nativeProjectName(f.child), query: 'fixture' } });
    assert.equal(gated.isError, true, JSON.stringify(gated.content));
    await pause(3000);
    const exited = new Promise(resolve => session.child.once('exit', () => resolve(true)));
    session.child.stdin.end();
    const closed = await Promise.race([exited, pause(30000).then(() => false)]);
    assert.ok(closed, 'the wrapper must close its watcher sessions and exit after a normal host EOF');
    // The established watcher sessions must really be gone too.
    const survived = listFixtureProcesses(f.tag);
    if (survived) assert.deepEqual(survived, [], `watcher processes outlived a normal host EOF: ${JSON.stringify(survived)}`);
  } finally { session?.close(); await pause(500); f.cleanup(); }
});
test('[CBM-STARTUP-ISOLATION] a slow identity scan never blocks initialize, tools/list or the gate', { timeout: 240000 }, async () => {
  const f = slowScanFixture(600);
  let sessionA, sessionB;
  try {
    const beganA = Date.now();
    sessionA = await startSession(f.root, { timeout: 120000, args: [client()] });
    const initializeMs = Date.now() - beganA;
    const listed = await sessionA.request('tools/list');
    assert.ok(listed.tools.find(tool => tool.name === 'search_graph'));
    let answered = false;
    sessionA.request('tools/call', { name: 'search_graph', arguments: { project: f.project, query: 'fixture' } }).then(() => { answered = true; }, () => { answered = true; });
    await pause(1000);
    assert.equal(answered, false, 'a query must wait for the in-flight identity scan instead of passing through the gate');
    await endSession(sessionA); sessionA = undefined;
    // Baseline on the same machine without the slow workspace scan.
    rmSync(path.join(f.root, 'workspace.json'));
    const beganB = Date.now();
    sessionB = await startSession(f.root, { timeout: 120000, args: [client()] });
    const baselineMs = Date.now() - beganB;
    assert.ok(initializeMs - baselineMs < 5000, `initialize took ${initializeMs}ms with a slow scan against a ${baselineMs}ms baseline; the scan must run outside the protocol process`);
  } finally {
    await endSession(sessionA); await endSession(sessionB);
    f.cleanup();
  }
});
