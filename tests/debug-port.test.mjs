import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {selectDebugPort} from '../src/debug-port.mjs';

test('automatic port selection avoids stale/foreign listeners without stopping or trusting them',async t=>{
 const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const preferred=server.address().port;
 const listeners=async port=>port===preferred?[{pid:1,address:'127.0.0.1'}]:[];
 const verify=async()=>{throw new Error('wrong owner');};
 const chosen=await selectDebugPort({preferred,fixed:false,listeners,verify});
 assert.notEqual(chosen,preferred);assert.ok(chosen>=1024&&chosen<=65535);
 assert.ok(server.listening,'Existing listener must remain untouched');
 await assert.rejects(selectDebugPort({preferred,fixed:true,listeners,verify}),/Configured debug port/);
 assert.equal(await selectDebugPort({preferred,fixed:false,listeners,verify:async()=>{}}),preferred,'Verified native debug endpoint is reused');
 assert.equal(await selectDebugPort({preferred:chosen,fixed:true,listeners,verify}),chosen);
});
