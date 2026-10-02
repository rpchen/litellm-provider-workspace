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
  const roots = workingRoots(cwd);
  if (!roots.length) return { status: 'unselected', repositories: [] };
  const repositories = [];
  const deadline = Date.now() + (options.waitMs ?? 0);
  for (const root of roots) repositories.push(await (options.prepareRepository ?? prepareMain)(root, { ...options, waitMs: Math.max(0, deadline - Date.now()) }));
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
export class ReadinessGate {
  constructor(resolve, defaultRoot) { this.resolve = resolve; this.defaultRoot = defaultRoot; this.tools = new Map(); this.failures = new Map(); this.identities = new Map(); }
  register(tools) { for (const tool of tools) this.tools.set(tool.name, tool.inputSchema); }
  fail(roots, message) {
    for (const value of roots) {
      const root = canonicalRoot(value); this.failures.set(root, message);
      const aliases = new Set([root]);
      for (const name of ['artifact.json', 'selection.json']) {
        try { const project = JSON.parse(readFileSync(path.join(root, '.codebase-memory', name), 'utf8')).project; if (typeof project === 'string') aliases.add(project); } catch { /* Keep the root barrier even when metadata is unreadable. */ }
      }
      this.identities.set(root, aliases);
    }
  }
  success(receipts) {
    for (const receipt of receipts) if (['ready', 'working'].includes(receipt.status)) {
      const root = canonicalRoot(receipt.root); this.failures.delete(root); this.identities.delete(root);
    }
  }
  async check(name, args = {}) {
    if (!this.failures.size || ['list_projects', 'index_status'].includes(name)) return;
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
      const matched = [...this.identities].find(([, aliases]) => aliases.has(value) || (identity.project && aliases.has(identity.project)));
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
  const binary = binaryPath();
  const prepared = new Set(), workers = new Set(), observers = new Map();
  const sessionRoot = gitRoot(process.cwd()) ?? process.cwd();
  let resolver;
  const gate = new ReadinessGate(async project => {
    resolver ??= startSession(sessionRoot, { command: binary, args: [], timeout: 15000 });
    const native = await resolver;
    const value = toolData(await native.request('tools/call', { name: 'index_status', arguments: { project, format: 'json' } }));
    if (!value.root_path) throw new Error('Native project has no repository root');
    return { root: value.root_path, project: value.project };
  }, sessionRoot);
  let child;
  function cleanup() { child?.kill(); for (const worker of workers) worker.kill(); for (const session of observers.values()) session.then(value => value?.close()); resolver?.then(value => value?.close()).catch(() => {}); }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup(); process.exit(1); });
  async function prepareOne(cwd) {
    const repo = optedRepository(cwd);
    if (!repo) return;
    if (selection(repo.root)) { await prepareMain(cwd, { mode: 'resume' }); return; }
    const cache = process.env.CBM_RELEASE_CACHE ?? path.join(os.homedir(), '.cache/codebase-memory-releases');
    try { sync(repo, cache); } catch (error) { console.error(`[codebase-memory] Release sync deferred: ${error.message.split('\n')[0]}`); }
    try { refresh(repo, { binary, execute: (command, argv, options) => run(command, argv, { ...options, timeout: 30000 }) }); }
    catch (error) { console.error(`[codebase-memory] Working index refresh deferred: ${error.message.split('\n')[0]}`); }
  }
  async function prepare(cwd) {
    let roots;
    try { roots = workingRoots(cwd); }
    catch (error) { gate.fail(error.expectedRoots ?? [gitRoot(cwd) ?? sessionRoot], error.message); return error.expectedRoots ?? []; }
    await Promise.all(roots.filter(root => !prepared.has(root)).map(root => {
      prepared.add(root);
      return new Promise(resolve => {
        const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), 'prepare-one', root], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'] });
        workers.add(worker);
        const timeout = setTimeout(() => worker.kill(), 50000);
        const done = code => {
          clearTimeout(timeout); workers.delete(worker);
          if (selection(root)) { if (code === 0) gate.success([{ root, status: 'working' }]); else gate.fail([root], 'Repository preparation failed; call prepare_codebase_task before new work'); }
          resolve();
        };
        worker.on('error', () => done(1)); worker.on('exit', done);
      });
    }));
    return roots;
  }
  if (args[0] === 'prepare-one') { await prepareOne(args[1] ?? process.cwd()); return; }
  if (args[0] === 'prepare') { await prepare(args[1] ?? process.cwd()); if (gate.failures.size) throw new Error([...gate.failures.values()].join('\n')); return; }
  async function observe(roots) {
    // Workspace children have independent Git status. Keep native sessions for
    // their already indexed databases so each gets its own watcher registration.
    await Promise.all(roots.filter(root => root !== sessionRoot).map(root => {
      if (!observers.has(root)) observers.set(root, startSession(root, { command: binary, args: [], timeout: 15000 }).catch(() => undefined));
      return observers.get(root);
    }));
  }
  if (args[0] !== 'hook-augment') {
    const roots = await prepare(sessionRoot);
    if (!args.length) await observe(roots);
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
            const message = normalizeRoots(JSON.parse(line));
            if (message.method === 'tools/list') toolLists.add(message.id);
            if (message.method === 'tools/call' && TASK_TOOLS.some(tool => tool.name === message.params?.name)) {
              try {
                const args = message.params.arguments ?? {};
                if (typeof args.cwd !== 'string' || !path.isAbsolute(args.cwd) || !Number.isInteger(args.wait_ms ?? 60000) || (args.wait_ms ?? 60000) < 0 || (args.wait_ms ?? 60000) > 120000 || !['new', 'resume'].includes(args.mode ?? 'new')) throw new Error('Invalid task preparation arguments');
                const result = await prepareTask(args.cwd, { mode: message.params.name === 'finish_codebase_task' ? 'finish' : args.mode ?? 'new', waitMs: args.wait_ms ?? 60000 });
                gate.success(result.repositories);
                await observe(workingRoots(args.cwd));
                process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false } }) + '\n');
              } catch (error) {
                let roots = error.expectedRoots;
                if (!roots) { try { roots = workingRoots(message.params.arguments?.cwd ?? sessionRoot); } catch (failure) { roots = failure.expectedRoots; } }
                gate.fail(roots ?? [sessionRoot], error.message);
                process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: error.message }], isError: true } }) + '\n');
              }
              return;
            }
            if (message.method === 'tools/call') {
              try {
                if (!gate.tools.has(message.params.name) && gate.failures.size) {
                  resolver ??= startSession(sessionRoot, { command: binary, args: [], timeout: 15000 });
                  gate.register((await (await resolver).request('tools/list')).tools);
                }
                await gate.check(message.params.name, message.params.arguments);
              } catch (error) {
                process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: error.message }], isError: true } }) + '\n'); return;
              }
            }
            for (const root of message.result?.roots ?? []) if (root.uri?.startsWith('file:')) await observe(await prepare(fileURLToPath(root.uri)));
            forwarded = JSON.stringify(message);
          } catch { /* Forward malformed protocol messages for native handling. */ }
          if (!child.stdin.destroyed) child.stdin.write(forwarded + '\n');
        });
      }
    });
    process.stdin.on('end', () => pending.then(() => { if (!child.stdin.destroyed) { if (buffer) child.stdin.write(buffer); child.stdin.end(); } }));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
