#!/usr/bin/env node
// Global client entry point. stdout is reserved for the native MCP/CLI protocol.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { binaryPath, repository, run, sync, refresh } from './codebase-memory.mjs';
import { toolData } from './codebase-memory.mjs';
import { startSession } from './codebase-memory-session.mjs';
import { selection, prepareMain } from './codebase-memory-main.mjs';

export const TASK_TOOLS = ['prepare_codebase_task', 'finish_codebase_task'].map(name => ({
  name,
  description: name === 'prepare_codebase_task'
    ? 'Run first for every NEW task. Fetch latest main, preserve unfinished work, and require the matching verified remote index before starting. Use resume only to continue existing work.'
    : 'Run after an explicitly authorized PR merge. Return to latest main and verify local immutable index bytes match the remote snapshot. A merged PR alone is not completion.',
  inputSchema: { type: 'object', properties: { cwd: { type: 'string', description: 'Absolute directory of the current task repository or workspace' }, mode: { type: 'string', enum: ['new', 'resume'], default: 'new' }, wait_ms: { type: 'integer', minimum: 0, maximum: 120000, default: 60000 } }, required: ['cwd'], additionalProperties: false }
}));
export async function prepareTask(cwd, options = {}) {
  const roots = options.roots ?? workingRoots(cwd);
  if (!roots.length) return { status: 'unselected', repositories: [] };
  const repositories = [];
  const deadline = (options.waitMs ?? 0) > 0 ? Date.now() + options.waitMs : undefined;
  for (const root of roots) {
    if (deadline && Date.now() >= deadline) throw new Error('Workspace index preparation timed out');
    repositories.push(await (options.prepareRepository ?? prepareMain)(root, { ...options, waitMs: deadline ? Math.max(1, deadline - Date.now()) : 0 }));
    if (deadline && Date.now() >= deadline) throw new Error('Workspace index preparation timed out');
  }
  if (repositories.length !== roots.length || roots.some(root => repositories.filter(repo => path.resolve(repo.root) === path.resolve(root)).length !== 1)) throw new Error('Not all expected repositories have a successful preparation receipt');
  for (const result of repositories) {
    if (result.status === 'ready') {
      if (!existsSync(path.join(result.root, '.codebase-memory/artifact.json'))) throw new Error('Ready receipt is missing selected repository metadata');
      const actual = optedRepository(result.root);
      const marker = JSON.parse(readFileSync(path.join(result.root, '.codebase-memory/artifact.json'), 'utf8'));
      if (!actual || marker.commit !== result.commit || marker.project !== result.project || result.commit !== run('git', ['rev-parse', 'HEAD'], { cwd: result.root }) || result.branch !== run('git', ['branch', '--show-current'], { cwd: result.root }) || result.index_commit !== result.commit) throw new Error('Preparation receipt differs from actual repository identity');
    }
  }
  return { status: repositories.every(repo => repo.status === 'ready') ? 'ready' : 'working', repositories };
}

function gitRoot(cwd) {
  try { return realpathSync(run('git', ['rev-parse', '--show-toplevel'], { cwd })); }
  catch (error) { if (/not a git repository|cannot change to/.test(error.message)) return undefined; throw error; }
}
// The session root is needed before the native daemon can start, but resolving
// it must never block the protocol event loop: the Git child runs
// asynchronously and a failed probe falls back to the caller's directory.
function gitRootAsync(cwd, timeout = 15000) {
  return new Promise(resolve => {
    const worker = spawn('git', ['rev-parse', '--show-toplevel'], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    worker.stdout.setEncoding('utf8'); worker.stderr.setEncoding('utf8');
    worker.stdout.on('data', value => output += value); worker.stderr.on('data', value => error += value);
    const timer = setTimeout(() => worker.kill(), timeout);
    const settle = code => {
      clearTimeout(timer);
      if (code === 0) { try { return resolve(realpathSync(output.trim())); } catch { return resolve(undefined); } }
      if (/not a git repository|cannot change to/.test(error) || /not a git repository|cannot change to/.test(output)) return resolve(undefined);
      resolve(undefined);
    };
    worker.on('error', () => settle(1));
    worker.on('exit', code => settle(code));
  });
}
export function optedRepository(cwd) {
  const root = gitRoot(cwd);
  if (!root || !['selection.json', 'artifact.json'].some(name => existsSync(path.join(root, '.codebase-memory', name)))) return undefined;
  try {
    const chosen = selection(root);
    const repo = repository(root);
    if (chosen && existsSync(path.join(root, '.codebase-memory/artifact.json'))) {
      const artifact = JSON.parse(readFileSync(path.join(root, '.codebase-memory/artifact.json'), 'utf8'));
      if (artifact.schema_version !== 2 || !/^[a-f0-9]{40}$/.test(artifact.commit ?? '')) throw new Error('Invalid selected repository metadata');
      const native = root.replaceAll('\\', '/').replace(/[^\w.-]/g, '-').replace(/-+/g, '-');
      if (![chosen.project, native].includes(artifact.project) && artifact.project !== `${chosen.project}-main-${artifact.commit}`) {
        const status = toolData(JSON.parse(run(binaryPath(), ['cli', '--quiet', '--json', 'index_status', '--project', artifact.project, '--format', 'json'], { cwd: root })));
        if (!status.root_path || path.resolve(status.root_path) !== path.resolve(root)) throw new Error('Selected repository metadata identity does not match its root');
      }
    }
    return { ...repo, root };
  } catch (error) { error.message = `Selected repository metadata failed at ${root}: ${error.message}`; error.expectedRoots = [root]; throw error; }
}
export function workingRoots(cwd) {
  const root = gitRoot(cwd);
  if (!root) return [];
  const candidates = [root];
  const manifest = path.join(root, 'workspace.json');
  if (existsSync(manifest)) {
      for (const entry of JSON.parse(readFileSync(manifest, 'utf8')).repos ?? []) {
        if (!/^[\w.-]+$/.test(entry.name) || entry.name === '.' || entry.name === '..') continue;
        const candidate = path.join(root, entry.name);
        if (!existsSync(path.join(candidate, '.git'))) continue;
        if (['selection.json', 'artifact.json'].some(name => existsSync(path.join(candidate, '.codebase-memory', name)))) candidates.push(realpathSync(candidate));
      }
  }
  const expected = [...new Set(candidates.filter(candidate => ['selection.json', 'artifact.json'].some(name => existsSync(path.join(candidate, '.codebase-memory', name)))))];
  try { return expected.map(candidate => optedRepository(candidate).root); }
  catch (error) { error.expectedRoots = expected; throw error; }
}

function canonicalRoot(root) { try { return path.resolve(realpathSync(root)); } catch { return path.resolve(root); } }
function nativeProject(root) { return root.replaceAll('\\', '/').replace(/[^\w.-]/g, '-').replace(/-+/g, '-'); }
export class ReadinessGate {
  constructor(resolve, defaultRoot) { this.resolve = resolve; this.defaultRoot = defaultRoot; this.tools = new Map(); this.failures = new Map(); this.identities = new Map(); this.pending = new Map(); this.rounds = new Map(); }
  register(tools) { for (const tool of tools) this.tools.set(tool.name, tool.inputSchema); }
  // Every preparation attempt claims a per-root round number. Results carry
  // the round they started in, so a callback from an older round can never
  // overwrite the outcome of a newer round: a late background success must
  // not clear a newer explicit failure (and vice versa).
  beginRound(roots) {
    const rounds = new Map();
    for (const value of roots) {
      const root = canonicalRoot(value);
      const round = (this.rounds.get(root) ?? 0) + 1;
      this.rounds.set(root, round);
      rounds.set(root, round);
    }
    return rounds;
  }
  track(roots) {
    // Queries must not race an in-flight preparation of the same root: they
    // wait for its outcome instead of passing on a not-yet-verified state.
    const wake = [];
    for (const value of roots) {
      const root = canonicalRoot(value);
      let entry = this.pending.get(root);
      if (!entry) { let settle; const promise = new Promise(resolve => settle = resolve); entry = { count: 0, promise, settle }; this.pending.set(root, entry); }
      entry.count++;
      wake.push(() => { if (--entry.count === 0) { this.pending.delete(root); entry.settle(); } });
    }
    return () => { for (const release of wake) release(); };
  }
  awaitSettled(root) {
    const entry = this.pending.get(canonicalRoot(root));
    return entry ? entry.promise : Promise.resolve();
  }
  fail(roots, message, round) {
    for (const value of roots) {
      const root = canonicalRoot(value);
      if (round) { if (round.get(root) !== this.rounds.get(root)) continue; }
      else this.rounds.set(root, (this.rounds.get(root) ?? 0) + 1);
      this.failures.set(root, message);
      const aliases = new Set([root, nativeProject(root)]);
      for (const name of ['artifact.json', 'selection.json']) {
        try { const project = JSON.parse(readFileSync(path.join(root, '.codebase-memory', name), 'utf8')).project; if (typeof project === 'string') aliases.add(project); } catch { /* Keep the root barrier even when metadata is unreadable. */ }
      }
      this.identities.set(root, aliases);
    }
  }
  success(receipts, round) {
    for (const receipt of receipts) if (['ready', 'working'].includes(receipt.status)) {
      const root = canonicalRoot(receipt.root);
      if (round) { if (round.get(root) !== this.rounds.get(root)) continue; }
      else this.rounds.set(root, (this.rounds.get(root) ?? 0) + 1);
      this.failures.delete(root); this.identities.delete(root);
    }
  }
  async check(name, args = {}) {
    if (['list_projects', 'index_status'].includes(name)) return;
    // A preparation still in flight may be about to succeed or fail for this
    // root; queries wait for that outcome before the gate decides. Waiting
    // needs no tool schema: only a failure rejection identifies project args.
    if (this.pending.size) await Promise.all([...this.pending.values()].map(entry => entry.promise));
    if (!this.failures.size) return;
    const schema = this.tools.get(name);
    if (!schema) throw new Error('Tool schema has not been discovered; readiness cannot be established');
    const keys = Object.keys(schema.properties ?? {}).filter(key => key === 'project' || key.endsWith('_project'));
    // Native 0.11 also accepts these spellings even though only project is
    // advertised in the registry. Never let an accepted alias skip the gate.
    if (keys.includes('project')) for (const alias of ['project_name', 'project_id', 'projectName']) if (args[alias] !== undefined) keys.push(alias);
    if (!keys.length) return;
    for (const key of keys) {
      const value = args[key];
      if (value === undefined && keys.some(other => other !== key && args[other] !== undefined)) continue;
      let identity;
      try { identity = value ? await this.resolve(value) : { root: this.defaultRoot }; }
      catch { throw new Error('Project identity cannot be resolved while repository preparation has failed'); }
      if (typeof identity === 'string') identity = { root: identity };
      if (!identity?.root) throw new Error('Project identity cannot be resolved while repository preparation has failed');
      const matched = [...this.identities].find(([, aliases]) => [value, identity.project].some(project =>
        typeof project === 'string' && [...aliases].some(alias => project === alias ||
          (project.startsWith(`${alias}-main-`) && /^[a-f0-9]{40}$/.test(project.slice(alias.length + 6))))));
      const failure = this.failures.get(canonicalRoot(identity.root)) ?? (matched ? this.failures.get(matched[0]) : undefined);
      if (failure) throw new Error(failure);
    }
  }
}
export function normalizeRoots(message) {
  if (!Array.isArray(message.result?.roots)) return message;
  return { ...message, result: { ...message.result, roots: message.result.roots.map(root => {
    if (!root.uri?.startsWith('file:')) return root;
    const repo = optedRepository(fileURLToPath(root.uri));
    return repo ? { ...root, uri: pathToFileURL(repo.root).href } : root;
  }) } };
}
export async function main(args = process.argv.slice(2)) {
  // Project identity resolution may invoke the native CLI, which can be
  // arbitrarily slow. These worker entries run the synchronous scan in a
  // separate process and report JSON on stdout, so the protocol process never
  // blocks initialize/tools/list on it.
  if (args[0] === 'roots') {
    try { process.stdout.write(JSON.stringify({ roots: workingRoots(args[1] ?? process.cwd()) }) + '\n'); }
    catch (error) { process.stdout.write(JSON.stringify({ error: { message: error.message, expectedRoots: error.expectedRoots ?? [] } }) + '\n'); process.exitCode = 1; }
    return;
  }
  if (args[0] === 'opted') {
    try {
      const values = JSON.parse(args[1] ?? '[]');
      process.stdout.write(JSON.stringify({ roots: values.map(value => optedRepository(value)?.root ?? null) }) + '\n');
    } catch (error) { process.stdout.write(JSON.stringify({ error: { message: error.message, expectedRoots: error.expectedRoots ?? [] } }) + '\n'); process.exitCode = 1; }
    return;
  }
  const binary = binaryPath();
  if (args[0] === 'prepare-one') { await prepareOne(args[1] ?? process.cwd()); return; }
  const prepared = new Set(), workers = new Set(), observers = new Map(), sessions = new Set();
  const preparations = new Map();
  let closing = false;
  async function prepareOne(cwd) {
    const repo = optedRepository(cwd);
    if (!repo) return;
    if (selection(repo.root)) { await prepareMain(cwd, { mode: 'resume' }); return; }
    const cache = process.env.CBM_RELEASE_CACHE ?? path.join(os.homedir(), '.cache/codebase-memory-releases');
    try { sync(repo, cache); } catch (error) { console.error(`[codebase-memory] Release sync deferred: ${error.message.split('\n')[0]}`); }
    try { refresh(repo, { binary, execute: (command, argv, options) => run(command, argv, { ...options, timeout: 30000 }) }); }
    catch (error) { console.error(`[codebase-memory] Working index refresh deferred: ${error.message.split('\n')[0]}`); }
  }
  const sessionRoot = await gitRootAsync(process.cwd()) ?? process.cwd();
  function runWorker(argv, options = {}) {
    return new Promise((resolve, reject) => {
      if (closing) return reject(new Error('Session is closing'));
      const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), ...argv], { cwd: options.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      workers.add(worker);
      let output = '', error = '';
      worker.stdout.setEncoding('utf8'); worker.stderr.setEncoding('utf8');
      worker.stdout.on('data', value => output += value); worker.stderr.on('data', value => error += value);
      const timer = setTimeout(() => worker.kill(), options.timeout ?? 60000);
      const settle = code => {
        clearTimeout(timer); workers.delete(worker);
        let payload; try { payload = JSON.parse(output.trim().split('\n').filter(Boolean).at(-1) ?? ''); } catch { payload = undefined; }
        if (code === 0 && payload && typeof payload === 'object') return resolve(payload);
        const failure = new Error(payload?.error?.message ?? (error.trim() || `Repository worker failed with code ${code}`));
        failure.expectedRoots = payload?.error?.expectedRoots ?? [];
        reject(failure);
      };
      worker.on('error', () => settle(1));
      worker.on('exit', code => settle(code));
    });
  }
  async function resolveRoots(cwd) {
    if (closing) return [];
    const payload = await runWorker(['roots', cwd], { cwd, timeout: 300000 });
    if (!Array.isArray(payload.roots)) throw new Error('Repository resolution returned an invalid response');
    return payload.roots;
  }
  async function resolveOpted(values) {
    if (!values.length) return new Map();
    const payload = await runWorker(['opted', JSON.stringify(values)], { timeout: 300000 });
    if (!Array.isArray(payload.roots) || payload.roots.length !== values.length) throw new Error('Repository identity resolution returned an invalid response');
    return new Map(values.map((value, index) => [value, payload.roots[index] ?? null]));
  }
  async function normalizeReportedRoots(message) {
    if (!Array.isArray(message.result?.roots)) return message;
    const fileRoots = message.result.roots.filter(root => root.uri?.startsWith('file:'));
    if (!fileRoots.length) return message;
    const resolved = await resolveOpted(fileRoots.map(root => fileURLToPath(root.uri)));
    return { ...message, result: { ...message.result, roots: message.result.roots.map(root => {
      if (!root.uri?.startsWith('file:')) return root;
      const repoRoot = resolved.get(fileURLToPath(root.uri));
      return repoRoot ? { ...root, uri: pathToFileURL(repoRoot).href } : root;
    }) } };
  }
  async function openSession(cwd, options) {
    if (closing) return undefined;
    let session;
    try { session = await startSession(cwd, options); }
    catch (error) { if (closing) return undefined; throw error; }
    if (closing) { session.close(); return undefined; }
    sessions.add(session);
    return session;
  }
  function closeSessions() { for (const session of sessions) { try { session.close(); } catch { /* Already closed. */ } } sessions.clear(); }
  let resolver;
  function nativeSession() {
    const pending = resolver ?? (resolver = openSession(sessionRoot, { command: binary, args: [], timeout: 15000 }));
    return pending.then(value => {
      if (value) return value;
      if (resolver === pending) resolver = undefined;
      throw new Error('Session is closing');
    }, error => { if (resolver === pending) resolver = undefined; throw error; });
  }
  const gate = new ReadinessGate(async project => {
    const native = await nativeSession();
    const value = toolData(await native.request('tools/call', { name: 'index_status', arguments: { project, format: 'json' } }));
    if (!value.root_path) throw new Error('Native project has no repository root');
    return { root: value.root_path, project: value.project };
  }, sessionRoot);
  let child;
  function cleanup() {
    closing = true;
    child?.kill();
    for (const worker of workers) worker.kill();
    workers.clear();
    closeSessions();
    resolver = undefined;
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup(); process.exit(1); });
  async function prepare(cwd) {
    if (closing) return [];
    // Hold the gate while the roots are still unknown: a query that arrives
    // during the (possibly slow) identity scan waits for this preparation
    // outcome instead of passing through unverified.
    const scanning = gate.track([cwd]);
    let roots;
    try { roots = await resolveRoots(cwd); }
    catch (error) {
      if (!closing) gate.fail(error.expectedRoots?.length ? error.expectedRoots : [cwd, sessionRoot], error.message);
      scanning();
      return error.expectedRoots ?? [];
    }
    if (closing) { scanning(); return roots; }
    // Track the in-flight startup preparation per root: queries targeting
    // these roots wait for the outcome instead of racing an unverified state.
    // A root whose last attempt failed is retried when the host re-reports
    // it (for example after fixing metadata): recovery must reopen the gate.
    const starting = roots.filter(root => !prepared.has(root) || gate.failures.has(canonicalRoot(root)));
    const round = gate.beginRound(starting);
    const settled = gate.track(starting);
    scanning();
    const running = Promise.all(starting.map(root => {
      prepared.add(root);
      return new Promise(resolve => {
        if (closing) { resolve(); return; }
        const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), 'prepare-one', root], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'] });
        workers.add(worker);
        const timeout = setTimeout(() => worker.kill(), 50000);
        const done = code => {
          clearTimeout(timeout); workers.delete(worker);
          if (!closing) {
            if (code === 0) gate.success([{ root, status: selection(root) ? 'working' : 'ready' }], round);
            else if (selection(root)) gate.fail([root], 'Repository preparation failed; call prepare_codebase_task before new work', round);
          }
          resolve();
        };
        worker.on('error', () => done(1)); worker.on('exit', done);
      });
    })).then(() => settled());
    // The CLI 'prepare' entry waits for the outcome to report it; the
    // startup path stores it so watcher sessions open only after the
    // working graphs exist (the native daemon registers watchers when a
    // session starts, against what the database already contains).
    if (args[0] === 'prepare') { await running; return roots; }
    (preparations.get(cwd) ?? preparations.set(cwd, []).get(cwd)).push(running);
    return roots;
  }
  if (args[0] === 'prepare') { await prepare(args[1] ?? process.cwd()); if (gate.failures.size) throw new Error([...gate.failures.values()].join('\n')); return; }
  async function observe(roots) {
    // Workspace children have independent Git status. Keep native sessions for
    // their already indexed databases so each gets its own watcher registration.
    // Cold starts under concurrent daemons can exceed a short handshake
    // timeout; retry once before giving up on the watcher session.
    if (closing) return;
    await Promise.all(roots.filter(root => root !== sessionRoot).map(root => {
      if (observers.has(root)) return observers.get(root);
      const opening = (async () => {
        let session;
        for (let attempt = 0; attempt < 2 && !session; attempt++) {
          if (closing) return undefined;
          session = await openSession(root, { command: binary, args: [], timeout: 60000 }).catch(() => undefined);
        }
        return session;
      })();
      // Register the in-flight session immediately so concurrent callers for
      // the same root share one watcher instead of opening a second one.
      observers.set(root, opening);
      return opening;
    }));
  }
  if (args[0] !== 'hook-augment') {
    // Never block the MCP handshake on preparation: the daemon starts
    // immediately and every synchronous project-identity scan runs in its own
    // process. The gate keeps queries waiting until the same preparation
    // outcome (success or explicit failure) has settled. Watcher sessions
    // open only after the preparations finish: the native daemon registers
    // watchers when a session starts, against what the database already
    // contains.
    const background = (async () => {
      const roots = await prepare(sessionRoot);
      if (closing) return;
      await Promise.all((preparations.get(sessionRoot) ?? []).map(pending => pending));
      if (closing) return;
      if (!args.length) await observe(roots);
    })();
    if (args.length) await background;
    else background.catch(error => { if (!closing) console.error(`[codebase-memory] Startup preparation failed: ${error.message}`); });
  }
  child = spawn(binary, args, { cwd: sessionRoot, windowsHide: true, stdio: ['pipe', args.length ? 'inherit' : 'pipe', 'inherit'] });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; cleanup(); });
  child.on('exit', code => { process.exitCode = code ?? 1; cleanup(); });
  child.stdin.on('error', () => {});
  if (args.length) process.stdin.pipe(child.stdin);
  else {
    // Desktop MCP launches may use a generic cwd. Normalize each reported root
    // before preparation and forwarding, so the daemon selects the same DB.
    let buffer = '', outgoing = '', pending = Promise.resolve();
    const toolLists = new Set();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      outgoing += data;
      let end;
      while ((end = outgoing.indexOf('\n')) >= 0) {
        let line = outgoing.slice(0, end); outgoing = outgoing.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (toolLists.delete(message.id) && Array.isArray(message.result?.tools)) {
            gate.register(message.result.tools);
            message.result.tools.push(...TASK_TOOLS); line = JSON.stringify(message);
          }
        } catch { /* Preserve native diagnostics/protocol errors. */ }
        process.stdout.write(line + '\n');
      }
    });
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', data => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        pending = pending.then(async () => {
          let forwarded = line;
          try {
            const message = JSON.parse(line);
            // Protocol parsing succeeded. Roots normalization and repository
            // metadata validation are business failures, not protocol errors:
            // they must gate the reported root instead of being forwarded for
            // the native daemon, which would happily serve its own database.
            let handled = message;
            try { handled = await normalizeReportedRoots(message); }
            catch (error) { if (!closing) gate.fail(error.expectedRoots ?? [sessionRoot], error.message); return; }
            if (handled.method === 'tools/list') toolLists.add(handled.id);
            if (handled.method === 'tools/call' && TASK_TOOLS.some(tool => tool.name === handled.params?.name)) {
              let roots = [];
              try {
                const args = handled.params.arguments ?? {};
                if (typeof args.cwd !== 'string' || !path.isAbsolute(args.cwd) || !Number.isInteger(args.wait_ms ?? 60000) || (args.wait_ms ?? 60000) < 0 || (args.wait_ms ?? 60000) > 120000 || !['new', 'resume'].includes(args.mode ?? 'new')) throw new Error('Invalid task preparation arguments');
                // Project identity resolution stays out of the protocol
                // process even for explicit preparations.
                roots = await resolveRoots(args.cwd);
                const result = await prepareTask(args.cwd, { mode: handled.params.name === 'finish_codebase_task' ? 'finish' : args.mode ?? 'new', waitMs: args.wait_ms ?? 60000, roots });
                gate.success(result.repositories);
                await observe(result.repositories.map(receipt => receipt.root));
                process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: handled.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false } }) + '\n');
              } catch (error) {
                if (error.expectedRoots?.length) roots = error.expectedRoots;
                if (!closing) gate.fail(roots.length ? roots : [sessionRoot], error.message);
                process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: handled.id, result: { content: [{ type: 'text', text: error.message }], isError: true } }) + '\n');
              }
              return;
            }
            if (handled.method === 'tools/call') {
              try {
                if (!gate.tools.has(handled.params.name) && gate.failures.size) {
                  const native = await nativeSession();
                  gate.register((await native.request('tools/list')).tools);
                }
                await gate.check(handled.params.name, handled.params.arguments);
              } catch (error) {
                process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: handled.id, result: { content: [{ type: 'text', text: error.message }], isError: true } }) + '\n'); return;
              }
            }
            for (const root of handled.result?.roots ?? []) if (root.uri?.startsWith('file:')) {
              // The reported root may be new to this session; its watcher
              // session must open after its own preparation settles, exactly
              // like the startup path.
              if (closing) break;
              const reportedRoot = fileURLToPath(root.uri);
              const roots = await prepare(reportedRoot);
              await Promise.all((preparations.get(reportedRoot) ?? []).map(pending => pending));
              await observe(roots);
            }
            forwarded = JSON.stringify(handled);
          } catch { /* Forward malformed protocol messages for native handling. */ }
          if (!child.stdin.destroyed) child.stdin.write(forwarded + '\n');
        });
      }
    });
    process.stdin.on('end', () => {
      // The host connection is gone: stop background preparation and any
      // watcher sessions that would otherwise outlive the protocol process.
      closing = true;
      for (const worker of workers) worker.kill();
      workers.clear();
      pending.then(() => { if (!child.stdin.destroyed) { if (buffer) child.stdin.write(buffer); child.stdin.end(); } });
    });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
