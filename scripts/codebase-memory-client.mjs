#!/usr/bin/env node
// Global client entry point. stdout is reserved for the native MCP/CLI protocol.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { binaryPath, repository, run, sync, refresh } from './codebase-memory.mjs';
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
  for (const root of roots) repositories.push(await prepareMain(root, { ...options, waitMs: Math.max(0, deadline - Date.now()) }));
  return { status: repositories.every(repo => repo.status === 'ready') ? 'ready' : 'working', repositories };
}

export function optedRepository(cwd) {
  try { const repo = repository(cwd); return { ...repo, root: realpathSync(repo.root) }; } catch { return undefined; }
}
export function workingRoots(cwd) {
  const repo = optedRepository(cwd);
  if (!repo) return [];
  const roots = [repo.root];
  const manifest = path.join(repo.root, 'workspace.json');
  if (existsSync(manifest)) {
    try {
      for (const entry of JSON.parse(readFileSync(manifest, 'utf8')).repos ?? []) {
        if (!/^[\w.-]+$/.test(entry.name) || entry.name === '.' || entry.name === '..') continue;
        const candidate = path.join(repo.root, entry.name);
        if (!existsSync(path.join(candidate, '.git'))) continue;
        const child = optedRepository(candidate);
        if (child && child.root !== repo.root) roots.push(child.root);
      }
    } catch { /* A malformed manifest does not block the opted-in root. */ }
  }
  return [...new Set(roots)];
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
  const prepared = new Set(), workers = new Set(), observers = new Map(), failures = new Map();
  let child;
  function cleanup() { child?.kill(); for (const worker of workers) worker.kill(); for (const session of observers.values()) session.then(value => value?.close()); }
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
    const roots = workingRoots(cwd);
    await Promise.all(roots.filter(root => !prepared.has(root)).map(root => {
      prepared.add(root);
      return new Promise(resolve => {
        const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), 'prepare-one', root], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'] });
        workers.add(worker);
        const timeout = setTimeout(() => worker.kill(), 50000);
        const done = code => {
          clearTimeout(timeout); workers.delete(worker);
          if (selection(root)) { if (code === 0) failures.delete(root); else failures.set(root, 'Repository preparation failed; call prepare_codebase_task before new work'); }
          resolve();
        };
        worker.on('error', () => done(1)); worker.on('exit', done);
      });
    }));
    return roots;
  }
  if (args[0] === 'prepare-one') { await prepareOne(args[1] ?? process.cwd()); return; }
  if (args[0] === 'prepare') { await prepare(args[1] ?? process.cwd()); return; }
  const sessionRoot = optedRepository(process.cwd())?.root ?? process.cwd();
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
                for (const root of workingRoots(args.cwd)) failures.delete(root);
                await observe(workingRoots(args.cwd));
                process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false } }) + '\n');
              } catch (error) {
                for (const root of workingRoots(message.params.arguments?.cwd ?? sessionRoot)) if (selection(root)) failures.set(root, error.message);
                process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: error.message }], isError: true } }) + '\n');
              }
              return;
            }
            if (message.method === 'tools/call' && message.params.arguments?.project) {
              const refused = [...failures].find(([root]) => [optedRepository(root)?.project, selection(root)?.project].includes(message.params.arguments.project));
              if (refused) {
                process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: refused[1] }], isError: true } }) + '\n');
                return;
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
