import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpSession } from './codebase-memory-session.mjs';

const source = '源码: 中文函数 😀🚀\nexport function 中文函数() { return "完成 ✅"; }';
const response = id => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: source }], structuredContent: { source } } });
// The child waits for an acknowledgement after the parent consumes the first
// chunk. This guarantees two separate reads, independent of OS pipe buffering.
const childSource = `
process.stdin.setEncoding('utf8');
let buffer = '', remainder;
process.stdin.on('data', data => {
  buffer += data;
  let end;
  while ((end = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    const message = JSON.parse(line);
    if (message.method === 'fixture/continue') {
      if (remainder) { process.stdout.write(remainder); remainder = undefined; }
    } else if (message.method === 'tools/call') {
      const result = { content: [{ type: 'text', text: message.params.source }], structuredContent: { source: message.params.source } };
      const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n', 'utf8');
      const split = message.params.split;
      if (split === null) process.stdout.write(bytes);
      else { remainder = bytes.subarray(split); process.stdout.write(bytes.subarray(0, split)); }
    }
  }
});
`;

async function exchange(split) {
  const session = new McpSession(process.cwd(), { command: process.execPath, args: ['--input-type=module', '-e', childSource], timeout: 10000 });
  let reads = 0;
  session.child.stdout.on('data', () => { reads++; if (reads === 1 && split !== null) session.send({ method: 'fixture/continue' }); });
  try {
    const result = await session.request('tools/call', { source, split });
    assert.deepEqual(result, response(1).result);
    assert.equal(reads, split === null ? 1 : 2, 'fixture forces the requested chunk boundary');
  } finally { session.close(); }
}

test('[CBM-UTF8] complete MCP responses preserve Chinese and emoji', { timeout: 15000 }, () => exchange(null));

test('[CBM-UTF8] actual subprocess chunks preserve every interior Chinese and emoji byte boundary', { timeout: 60000 }, async () => {
  const bytes = Buffer.from(JSON.stringify(response(1)) + '\n', 'utf8');
  for (const symbol of ['中', '😀']) {
    const encoded = Buffer.from(symbol, 'utf8');
    const start = bytes.indexOf(encoded); assert.ok(start > 0);
    for (let offset = 1; offset < encoded.length; offset++) await exchange(start + offset);
  }
});
