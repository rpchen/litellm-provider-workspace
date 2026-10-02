#!/usr/bin/env node
// Global client entry point. stdout is reserved for the native MCP/CLI protocol.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { binaryPath, repository, run, sync } from './codebase-memory.mjs';

const binary = binaryPath();
const prepared = new Set();
function prepareOne(cwd) {
  let repo;
  try { repo = repository(cwd); } catch { return; }
  if (prepared.has(repo.root)) return;
  prepared.add(repo.root);
  const cache = process.env.CBM_RELEASE_CACHE ?? path.join(os.homedir(), '.cache/codebase-memory-releases');
  try { sync(repo, cache); } catch (error) { console.error(`[codebase-memory] Release sync deferred: ${error.message.split('\n')[0]}`); }
  try {
    const result = JSON.parse(run(binary, ['cli', '--quiet', '--json', 'index_repository', '--repo-path', repo.root, '--name', repo.project, '--mode', 'full', '--persistence', 'false'], { cwd: repo.root, timeout: 30000 }));
    if (result.isError || result.error) throw new Error('Native indexing returned an error');
  } catch (error) { console.error(`[codebase-memory] Working index refresh deferred: ${error.message.split('\n')[0]}`); }
}
async function prepare(cwd) {
  let repo;
  try { repo = repository(cwd); } catch { return; }
  const roots = [repo.root];
  const manifest = path.join(repo.root, 'workspace.json');
  if (existsSync(manifest)) {
    try {
      for (const entry of JSON.parse(readFileSync(manifest, 'utf8')).repos ?? []) {
        if (!/^[\w.-]+$/.test(entry.name) || entry.name === '.' || entry.name === '..') continue;
        const candidate = path.join(repo.root, entry.name);
        if (existsSync(path.join(candidate, '.git')) && existsSync(path.join(candidate, '.codebase-memory/artifact.json'))) roots.push(candidate);
      }
    } catch { /* An unrelated/malformed manifest does not block graph access. */ }
  }
  await Promise.all(roots.filter(root => !prepared.has(root)).map(root => {
    prepared.add(root);
    return new Promise(resolve => {
      const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), 'prepare-one', root], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'] });
      const timeout = setTimeout(() => worker.kill(), 50000);
      worker.on('error', () => { clearTimeout(timeout); resolve(); });
      worker.on('exit', () => { clearTimeout(timeout); resolve(); });
    });
  }));
}
const args = process.argv.slice(2);
if (args[0] === 'prepare-one') { prepareOne(args[1] ?? process.cwd()); process.exit(0); }
if (args[0] === 'prepare') { await prepare(args[1] ?? process.cwd()); process.exit(0); }
if (args[0] === 'hook-augment') {
  // Preserve the short native hook path; MCP startup or Pi session_start performs sync.
} else await prepare(process.cwd());
const child = spawn(binary, args, { cwd: process.cwd(), windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'] });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
if (args.length) process.stdin.pipe(child.stdin);
else {
  // Desktop MCP launches may use a generic cwd. Also handle the actual roots/list response.
  let buffer = '';
  let pending = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', data => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      pending = pending.then(async () => {
        try {
          const message = JSON.parse(line);
          for (const root of message.result?.roots ?? []) if (root.uri?.startsWith('file:')) await prepare(fileURLToPath(root.uri));
        } catch { /* Forward protocol unchanged, including errors. */ }
        child.stdin.write(line + '\n');
      });
    }
  });
  process.stdin.on('end', () => pending.then(() => { if (buffer) child.stdin.write(buffer); child.stdin.end(); }));
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
