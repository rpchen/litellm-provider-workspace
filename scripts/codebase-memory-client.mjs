#!/usr/bin/env node
// Global client entry point. stdout is reserved for the native MCP/CLI protocol.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { binaryPath, repository, run, sync, refresh } from './codebase-memory.mjs';
import { startSession } from './codebase-memory-session.mjs';

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
  const prepared = new Set(), workers = new Set(), observers = new Map();
  let child;
  function cleanup() { child?.kill(); for (const worker of workers) worker.kill(); for (const session of observers.values()) session.then(value => value?.close()); }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup(); process.exit(1); });
  function prepareOne(cwd) {
    const repo = optedRepository(cwd);
    if (!repo) return;
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
        const done = () => { clearTimeout(timeout); workers.delete(worker); resolve(); };
        worker.on('error', done); worker.on('exit', done);
      });
    }));
    return roots;
  }
  if (args[0] === 'prepare-one') { prepareOne(args[1] ?? process.cwd()); return; }
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
  child = spawn(binary, args, { cwd: sessionRoot, windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'] });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; cleanup(); });
  child.on('exit', code => { process.exitCode = code ?? 1; cleanup(); });
  child.stdin.on('error', () => {});
  if (args.length) process.stdin.pipe(child.stdin);
  else {
    // Desktop MCP launches may use a generic cwd. Normalize each reported root
    // before preparation and forwarding, so the daemon selects the same DB.
    let buffer = '', pending = Promise.resolve();
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
