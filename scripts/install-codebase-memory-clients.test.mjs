import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { parseConfig, migrateOpenCode, setOpenCodeTimeout, fileEditor, configureOpenCode } from './codebase-memory-config.mjs';

test('[CBM-JSONC] migration preserves first, middle, last and nested configurations', () => {
  const target = 'codebase-memory-mcp';
  for (const position of [0, 1, 2]) {
    const entries = [['one', { command: ['one'] }], ['two', { command: ['two'] }]];
    entries.splice(position, 0, [target, { type: 'local', environment: { CBM: 'value', nested: { enabled: true } }, command: ['node', 'old'] }]);
    const before = { mcp: Object.fromEntries(entries), unrelated: { servers: ['keep'] } };
    const after = JSON.parse(migrateOpenCode(JSON.stringify(before)));
    delete before.mcp[target];
    assert.deepEqual(after, before);
  }
  const jsonc = `// retained header\n{ "mcp": { /* server one */ "one": {"command":["one"]},\n"codebase-memory-mcp":{"environment":{"nested":{"x":1}}},\n/* retained server two */ "two":{"command":["two"]}, }, "other":true, }`;
  const migrated = migrateOpenCode(jsonc);
  assert.ok(migrated.includes('// retained header'));
  assert.ok(migrated.includes('/* retained server two */'));
  assert.deepEqual(parseConfig(migrated).mcp, { one: { command: ['one'] }, two: { command: ['two'] } });
  const both = '{"mcp":{"codebase-memory-mcp":{"command":["legacy"]},"servers":{"codebase-memory-mcp":{"command":["current"]},"other":{"command":["other"]}}}}';
  assert.deepEqual(parseConfig(migrateOpenCode(both)).mcp.servers, parseConfig(both).mcp.servers);
  const timeout = setOpenCodeTimeout('// keep\n'+migrateOpenCode(both));
  assert.ok(timeout.includes('// keep'));
  assert.deepEqual(parseConfig(timeout).mcp.servers['codebase-memory-mcp'].timeout, { startup:120000, request:120000 });
  assert.throws(() => migrateOpenCode('{"mcp": { broken } }'), /valid JSONC/);
});

test('[CBM-BACKUP] original bytes survive migration, native CLI and timeout writes or failure', () => {
  const base = path.resolve('.tmp'); mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(path.join(base, 'cbm-backup-test-'));
  try {
    for (const legacy of [true, false]) for (const fail of [true, false]) {
      const scenario = path.join(dir, `${legacy}-${fail}`); mkdirSync(scenario);
      const backups = path.join(scenario, 'backup'); mkdirSync(backups);
      const file = path.join(scenario, 'opencode.jsonc');
      const bytes = Buffer.from('// 原始配置\r\n'+JSON.stringify({ mcp: legacy ? { 'codebase-memory-mcp': { command: ['old'], environment: { x: 1 } } } : { servers: { 'codebase-memory-mcp': { command:['old'] } } } })+'\r\n');
      writeFileSync(file, bytes);
      const editor = fileEditor(backups);
      const add = () => {
        assert.deepEqual(readFileSync(path.join(backups,readdirSync(backups)[0])), bytes, 'backup precedes native mutation');
        writeFileSync(file, '{"mcp":{"servers":{"codebase-memory-mcp":{"command":["new"]}}}}');
        if (fail) throw new Error('native CLI failure');
      };
      if (fail) assert.throws(() => configureOpenCode(file,editor,add), /native CLI failure/);
      else configureOpenCode(file,editor,add);
      editor.update(file, text => text+'\n');
      assert.equal(readdirSync(backups).length,1);
      assert.deepEqual(readFileSync(path.join(backups,readdirSync(backups)[0])),bytes);
    }
    const file = path.join(dir,'invalid.jsonc'); writeFileSync(file,'{ broken');
    const backups = path.join(dir,'invalid-backup'); mkdirSync(backups);
    let called = false;
    assert.throws(()=>configureOpenCode(file,fileEditor(backups),()=>called=true),/valid JSONC/);
    assert.equal(called,false); assert.equal(readFileSync(file,'utf8'),'{ broken');
  } finally {
    if (!dir.startsWith(base+path.sep)) throw new Error('Unsafe test cleanup');
    rmSync(dir,{recursive:true,force:true});
  }
});
