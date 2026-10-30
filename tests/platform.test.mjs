import test from 'node:test';
import assert from 'node:assert/strict';
import {windowsMain,validateWindowsListeners,psLiteral,requestedDebugPort} from '../src/platform.mjs';
const exe='C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\app\\ChatGPT.exe';
const main={pid:10,parent:1,command:exe,args:`"${exe}" --remote-debugging-port=9341`};
const renderer={pid:11,parent:10,command:exe,args:`"${exe}" --type=renderer`};
test('Windows detects a single main process, excludes Electron subprocesses, normalizes path case',()=>{
 assert.deepEqual(windowsMain([main,renderer],exe.toLowerCase()),[main]);
 assert.doesNotThrow(()=>validateWindowsListeners([{address:'127.0.0.1',pid:10}],[main,renderer],exe));
 assert.doesNotThrow(()=>validateWindowsListeners([{address:'::1',pid:10}],[main],exe));
 for(const listeners of [[],[{address:'0.0.0.0',pid:10}],[{address:'::',pid:10}],[{address:'127.0.0.1',pid:99}],[{address:'127.0.0.1',pid:11}]])assert.throws(()=>validateWindowsListeners(listeners,[main,renderer],exe));
 assert.throws(()=>validateWindowsListeners([{address:'127.0.0.1',pid:10}],[main,{...main,pid:20}],exe));
});
test('PowerShell literals cannot interpolate paths or apostrophes',()=>{
 assert.equal(psLiteral("C:\\O'Brien\\$(example).exe"),"'C:\\O''Brien\\$(example).exe'");
});

test('debug startup flags are parsed as complete arguments, including quoted values',()=>{
 for(const args of ['app.exe --remote-debugging-port=9341','app.exe --remote-debugging-port "9341"','app.exe "--remote-debugging-port=9341"'])assert.equal(requestedDebugPort(args),9341);
 for(const args of ['app.exe','app.exe --not-remote-debugging-port=9341','app.exe --remote-debugging-port=9341bad','app.exe --remote-debugging-port=99999'])assert.equal(requestedDebugPort(args),null);
});

test('Windows adapter executes real PowerShell and reads current process and listeners', {skip:process.platform!=='win32'}, async()=>{
 const {powershell,processes,listeners}=await import('../src/platform.mjs');
 assert.equal(await powershell("'中文 O''Brien'"),"中文 O'Brien");
 const rows=await processes();
 assert.ok(Array.isArray(rows));
 const self=rows.find(row=>row.pid===process.pid);
 assert.ok(self,'CIM must include current Node process');
 assert.ok(typeof self.command==='string'&&self.command.toLowerCase().endsWith('node.exe'));
 assert.ok(Array.isArray(await listeners(9341)));
});
