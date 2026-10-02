#!/usr/bin/env node
// User-level client setup. Run explicitly; never called by clone/bootstrap or CI.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { binaryPath, run } from './codebase-memory.mjs';
import { fileEditor, configureOpenCode } from './codebase-memory-config.mjs';

const profile = os.homedir();
const codexRoot = process.env.CODEX_HOME ?? path.join(profile, '.codex');
const installRoot = path.join(profile, '.agents', 'codebase-memory');
const backupRoot = mkdtempSync(path.join((mkdirSync(path.join(codexRoot, 'backups'), { recursive: true }), path.join(codexRoot, 'backups')), 'cbm-clients-'));
const editor = fileEditor(backupRoot);
const update = editor.update;
const instructions = `<!-- CBM_START -->
## codebase-memory
Only use the graph in the nearest Git repository when its root contains .codebase-memory/artifact.json. Never automatically index a new repository.
At session start or after compaction, read the marker's artifact.json project identifier, discover codebase-memory tools, call list_projects/index_status, and use search_graph, query_graph, trace_path, get_code_snippet, get_architecture before text search for structural code questions. Confirm project/root and coverage; use source reads for stale, skipped or missing coverage. If MCP tool discovery is deferred, search for codebase-memory tools first. Pi exposes these tools directly through its extension.
Read repository AGENTS.md instructions before implementation. Graph evidence does not replace current Git/source facts.
<!-- CBM_END -->`;
function instruct(file) {
  update(file, text => text.includes('<!-- CBM_START -->')
    ? text.replace(/<!-- CBM_START -->[\s\S]*?<!-- CBM_END -->/, instructions)
    : `${text.trimEnd()}\n\n${instructions}\n`);
}
async function tools(binary) {
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  let buffer = '';
  const pending = new Map(); let next = 0;
  const timer = setTimeout(() => child.kill(), 15000);
  child.stdout.on('data', data => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { const msg = JSON.parse(line); if (pending.has(msg.id)) { pending.get(msg.id).resolve(msg); pending.delete(msg.id); } } catch {}
    }
  });
  child.on('exit', () => { for (const p of pending.values()) p.reject(new Error('Native MCP exited before tool discovery')); });
  function request(method, params) { const id = ++next; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }); }
  try {
    const init = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'cbm-client-setup', version: '1' } });
    if (init.error) throw new Error(init.error.message);
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const result = await request('tools/list', {});
    if (!result.result?.tools?.length) throw new Error('No graph tools discovered');
    return result.result.tools;
  } finally { clearTimeout(timer); child.stdin.end(); child.kill(); }
}
const binary = binaryPath();
if (!path.isAbsolute(binary)) throw new Error('Install native codebase-memory-mcp first, or set CBM_BINARY to its absolute path');
const registry = await tools(binary);
mkdirSync(installRoot, { recursive: true });
for (const name of ['codebase-memory.mjs', 'codebase-memory-client.mjs', 'codebase-memory-session.mjs']) update(path.join(installRoot, name), () => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), name), 'utf8'));
const launcher = path.join(installRoot, 'codebase-memory-client.mjs').replaceAll('\\', '/');
const node = process.execPath.replaceAll('\\', '/');
// Wrapper has a stable installed location, independent of this workspace checkout.
update(path.join(codexRoot, 'config.toml'), text => {
  const block = `[mcp_servers.codebase-memory-mcp]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(launcher)}]\nenv_vars = ["CBM_CACHE_DIR", "CBM_RUNTIME_DIR"]\nstartup_timeout_sec = 120\n`;
  return /^\[mcp_servers\.codebase-memory-mcp\]/m.test(text)
    ? text.replace(/^\[mcp_servers\.codebase-memory-mcp\][\s\S]*?(?=^\[|^# <<<|$(?![\s\S]))/m, block)
    : `${text.trimEnd()}\n\n${block}`;
});
instruct(path.join(codexRoot, 'AGENTS.md'));
const claudeDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(profile, '.claude');
const claudeConfig = process.env.CLAUDE_CONFIG_DIR ? path.join(claudeDir, '.claude.json') : path.join(profile, '.claude.json');
update(claudeConfig, text => { const config = JSON.parse(text || '{}'); config.mcpServers ??= {}; config.mcpServers['codebase-memory-mcp'] = { type: 'stdio', command: node, args: [launcher] }; return JSON.stringify(config, null, 2) + '\n'; });
instruct(path.join(claudeDir, 'CLAUDE.md'));
const openDir = process.env.OPENCODE_CONFIG_DIR ?? path.join(profile, '.config/opencode');
const openConfig = process.env.OPENCODE_CONFIG ?? path.join(openDir, 'opencode.jsonc');
const openBinary = process.platform === 'win32' ? path.join(process.env.APPDATA, 'npm/node_modules/@opencode/cli/bin/opencode.exe') : 'opencode';
configureOpenCode(openConfig, editor, () => run(openBinary, ['mcp', 'add', '--global', 'codebase-memory-mcp', '--', node, launcher]));
instruct(path.join(openDir, 'AGENTS.md'));
const piDir = process.env.PI_CODING_AGENT_DIR ?? path.join(profile, '.pi/agent');
instruct(path.join(piDir, 'AGENTS.md'));
const extension = `// Installed from the native MCP registry by install-codebase-memory-clients.mjs.
import { startSession } from ${JSON.stringify(pathToFileURL(path.join(installRoot, 'codebase-memory-session.mjs')).href)};
const TOOLS = ${JSON.stringify(registry)};
export default function (pi) {
  let session, pending;
  async function connected(cwd) {
    if (!pending || session?.closed) pending = startSession(cwd).then(value => session = value).catch(error => { pending = undefined; throw error; });
    return pending;
  }
  pi.on('session_start', async (_event, ctx) => {
    session?.close(); session = undefined; pending = undefined;
    await connected(ctx.cwd).catch(() => {});
  });
  pi.on('session_shutdown', () => { session?.close(); pending = undefined; });
  for (const tool of TOOLS) pi.registerTool({
    name: tool.name, label: tool.name, description: tool.description, parameters: tool.inputSchema,
    async execute(_id, params, signal, _update, ctx) {
      const client = await connected(ctx.cwd);
      const result = await client.request('tools/call', { name: tool.name, arguments: params }, signal);
      if (result.isError || result.error) throw new Error(JSON.stringify(result));
      return { content: result.content ?? [{ type: 'text', text: JSON.stringify(result) }], details: result.structuredContent ?? result };
    }
  });
}
`;
update(path.join(piDir, 'extensions/cbmem.ts'), () => extension);
run(binary, ['config', 'set', 'auto_index', 'false']);
run(binary, ['config', 'set', 'auto_watch', 'true']);
console.log(`Configured Codex, Claude Code, OpenCode and Pi (${registry.length} graph tools). Backup: ${backupRoot}`);
