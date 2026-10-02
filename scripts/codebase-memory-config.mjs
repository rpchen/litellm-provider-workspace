import { existsSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse, modify, applyEdits } from 'jsonc-parser';

export function parseConfig(text) {
  const errors = [];
  const data = parse(text || '{}', errors, { allowTrailingComma: true });
  if (errors.length || !data || typeof data !== 'object' || Array.isArray(data)) throw new Error('OpenCode configuration is not valid JSONC');
  return data;
}
function edit(text, key, value) {
  const next = applyEdits(text || '{}', modify(text || '{}', key, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  parseConfig(next);
  return next;
}
export function migrateOpenCode(text) {
  const config = parseConfig(text);
  if (config.mcp?.['codebase-memory-mcp'] === undefined) return text;
  // Delete the exact v1 path, preserving nested values, separators and comments.
  return edit(text, ['mcp', 'codebase-memory-mcp'], undefined);
}
export function setOpenCodeTimeout(text) {
  const server = parseConfig(text).mcp?.servers?.['codebase-memory-mcp'];
  if (!server || typeof server !== 'object' || Array.isArray(server)) throw new Error('OpenCode did not persist its MCP server configuration');
  return edit(text, ['mcp', 'servers', 'codebase-memory-mcp', 'timeout'], { ...server.timeout, startup: 120000, request: 120000 });
}
export function fileEditor(backupRoot) {
  const backedUp = new Set();
  function backup(file) {
    const key = path.resolve(file);
    if (backedUp.has(key)) return;
    backedUp.add(key);
    if (existsSync(file)) copyFileSync(file, path.join(backupRoot, key.replace(/[:\\/]/g, '_')));
  }
  function update(file, transform) {
    const old = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const next = transform(old);
    if (next === old) return;
    backup(file);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, next);
  }
  return { backup, update };
}
export function configureOpenCode(file, editor, addServer) {
  // Capture original bytes before any migration or native CLI mutation, even if
  // a v2 configuration needs no migration and the CLI subsequently fails.
  parseConfig(existsSync(file) ? readFileSync(file, 'utf8') : '{}');
  editor.backup(file);
  editor.update(file, migrateOpenCode);
  addServer();
  editor.update(file, setOpenCodeTimeout);
}
