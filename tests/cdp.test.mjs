import test from 'node:test';
import assert from 'node:assert/strict';
import { validSocket, verifyOwners } from '../src/cdp.mjs';
import { validateThreadId } from '../src/reader.mjs';

test('debug sockets must be loopback, correct port, and credential free', () => {
  assert.equal(validSocket('ws://127.0.0.1:9341/devtools/page/1',9341),'ws://127.0.0.1:9341/devtools/page/1');
  for (const value of ['ws://example.com:9341/x','ws://127.0.0.1:9999/x','wss://127.0.0.1:9341/x','ws://user:pass@127.0.0.1:9341/x']) {
    assert.throws(() => validSocket(value,9341));
  }
});
test('thread selection requires an exact UUID, never a path or glob', () => {
  assert.equal(validateThreadId('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'),'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  for (const value of ['../auth.json','*','latest','',undefined]) assert.throws(() => validateThreadId(value));
});
test('permits only the exact inherited helper listener with verified direct parent', () => {
  const main = { pid: 10, parent: 1, command: '/app/main' };
  const helper = { pid: 11, parent: 10, command: '/helper' };
  assert.doesNotThrow(() => verifyOwners([main], '/app/main', '/helper'));
  assert.doesNotThrow(() => verifyOwners([main, helper], '/app/main', '/helper'));
  for (const records of [[helper], [], [main, {...helper,parent:99}], [main, {...helper,command:'/foreign'}], [main,{...main,pid:12}]]) {
    assert.throws(() => verifyOwners(records, '/app/main', '/helper'));
  }
});
