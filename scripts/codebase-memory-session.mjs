import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export class McpSession {
  constructor(cwd, { command = process.execPath, args = [fileURLToPath(new URL('./codebase-memory-client.mjs', import.meta.url))], env = process.env, timeout = 120000 } = {}) {
    this.cwd = cwd; this.timeout = timeout; this.pending = new Map(); this.nextId = 0; this.buffer = ''; this.closed = false;
    this.child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', data => this.receive(data));
    this.child.stderr.on('data', () => {});
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', () => this.fail(new Error('MCP session closed')));
    this.child.stdin.on('error', error => this.fail(error));
  }
  send(message) { if (!this.closed) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); }
  receive(data) {
    this.buffer += data;
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message.method === 'roots/list') this.send({ id: message.id, result: { roots: [{ uri: pathToFileURL(this.cwd).href }] } });
      else if (this.pending.has(message.id)) {
        const pending = this.pending.get(message.id); this.pending.delete(message.id); pending.cleanup();
        message.error ? pending.reject(new Error(message.error.message ?? 'MCP request failed')) : pending.resolve(message.result);
      }
    }
  }
  request(method, params = {}, signal) {
    if (this.closed) return Promise.reject(new Error('MCP session closed'));
    if (signal?.aborted) return Promise.reject(new Error('MCP request cancelled'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.send({ method: 'notifications/cancelled', params: { requestId: id } });
        this.pending.delete(id); cleanup(); reject(new Error('MCP request cancelled'));
      };
      const timer = setTimeout(() => { this.pending.delete(id); cleanup(); reject(new Error('MCP request timed out')); }, this.timeout);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', cancel, { once: true });
      this.send({ id, method, params });
    });
  }
  fail(error) {
    this.closed = true;
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
    this.pending.clear();
  }
  close() { this.fail(new Error('MCP session closed')); this.child.stdin.end(); this.child.kill(); }
}
export async function startSession(cwd, options) {
  const session = new McpSession(cwd, options);
  try {
    await session.request('initialize', { protocolVersion: '2024-11-05', capabilities: { roots: { listChanged: true } }, clientInfo: { name: 'codebase-memory-bridge', version: '1' } });
    session.send({ method: 'notifications/initialized' });
    return session;
  } catch (error) { session.close(); throw error; }
}
