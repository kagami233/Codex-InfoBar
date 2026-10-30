import test from 'node:test';
import assert from 'node:assert/strict';
import {windowsMain,validateWindowsListeners,psLiteral} from '../src/platform.mjs';
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
