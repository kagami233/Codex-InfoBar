import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {ensureWindowsLauncher} from '../src/windows-launcher.mjs';
import {powershell,psLiteral,resolveApp} from '../src/platform.mjs';

test('stable Windows launcher discovers versions at activation time and reads the current port without launching Codex',{skip:process.platform!=='win32',timeout:60000},async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),"infobar stable O'Brien "));
 t.after(async()=>{if(!path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep))throw new Error('Unsafe cleanup');await fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 const stateRoot=path.join(directory,'state'),options={stateRoot,app:{executable:process.execPath},run:powershell};
 const launcher=await ensureWindowsLauncher(options),before=await fs.readFile(launcher.executable);
 await ensureWindowsLauncher(options);assert.deepEqual(await fs.readFile(launcher.executable),before,'unchanged source must not recompile the fixed target');
 await fs.writeFile(path.join(stateRoot,'settings.json'),JSON.stringify({CODEX_INFOBAR_PORT:'9431'}));
 for(const version of ['1','2']){const app=path.join(directory,version,'app');await fs.mkdir(app,{recursive:true});await fs.writeFile(path.join(app,'ChatGPT.exe'),'not launched');}
 const names=['OpenAI.Codex_1.0.0.0_x64__2p2nqsd0c76g0','OpenAI.Codex_2.0.0.0_x64__2p2nqsd0c76g0','OpenAI.Codex_99.0.0.0_x64__otherpublisher'];
 const roots=[path.join(directory,'1'),path.join(directory,'2'),path.join(directory,'1')];
 const probe=JSON.parse(await powershell(`[Reflection.Assembly]::LoadFile(${psLiteral(launcher.executable)})|Out-Null;@{port=[CodexInfoBar.StableLauncher]::ReadPort(${psLiteral(path.join(stateRoot,'settings.json'))});selected=[CodexInfoBar.StableLauncher]::SelectExecutable(@(${names.map(psLiteral).join(',')}),@(${roots.map(psLiteral).join(',')}))}|ConvertTo-Json -Compress`));
 assert.equal(probe.port,9431);assert.equal(probe.selected,path.join(directory,'2/app/ChatGPT.exe'));
 await fs.rm(path.join(directory,'2/app/ChatGPT.exe'));
 assert.equal(await powershell(`[Reflection.Assembly]::LoadFile(${psLiteral(launcher.executable)})|Out-Null;[CodexInfoBar.StableLauncher]::SelectExecutable(@(${names.map(psLiteral).join(',')}),@(${roots.map(psLiteral).join(',')}))`),path.join(directory,'1/app/ChatGPT.exe'));
 const run=promisify(execFile);let app;try{app=await resolveApp();}catch{}
 if(app){const result=JSON.parse((await run(launcher.executable,['--probe'],{windowsHide:true})).stdout);assert.equal(result.Executable,app.executable);assert.equal(result.Port,9431);assert.match(result.Arguments,/--remote-debugging-address=127\.0\.0\.1 --remote-debugging-port=9431/);}
 else await assert.rejects(run(launcher.executable,['--probe'],{windowsHide:true}),error=>error.code===1&&/not installed|No registered Codex/.test(error.stderr));
 await fs.writeFile(path.join(stateRoot,'settings.json'),JSON.stringify({CODEX_INFOBAR_PORT:'0'}));
 await assert.rejects(powershell(`[Reflection.Assembly]::LoadFile(${psLiteral(launcher.executable)})|Out-Null;[CodexInfoBar.StableLauncher]::ReadPort(${psLiteral(path.join(stateRoot,'settings.json'))})`),/Invalid InfoBar debug port/);
 // Exercise background recovery alone, without invoking the app-launch entry point.
 const runtime=path.join(stateRoot,'runtime/src');await fs.mkdir(runtime,{recursive:true});
 const script=path.join(runtime,'watcher.mjs'),started=path.join(stateRoot,'started');
 await fs.writeFile(script,`import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(started)},'1');fs.writeFileSync(${JSON.stringify(path.join(stateRoot,'watcher-lock.json'))},JSON.stringify({pid:process.pid,script:process.argv[1]}));setTimeout(()=>{},4000);`);
 const recover=`[Reflection.Assembly]::LoadFile(${psLiteral(launcher.executable)})|Out-Null;[CodexInfoBar.StableLauncher].GetMethod('EnsureWatcher',[Reflection.BindingFlags]'Static,NonPublic').Invoke($null,@(${psLiteral(stateRoot)}))|Out-Null`;
 await powershell(recover);
 const deadline=Date.now()+5000;while(Date.now()<deadline){try{await fs.access(path.join(stateRoot,'watcher-lock.json'));break;}catch{}await new Promise(r=>setTimeout(r,50));}
 assert.equal(await fs.readFile(started,'utf8'),'1');
 await powershell(recover);assert.equal(await fs.readFile(started,'utf8'),'1','a verified running watcher must not be started twice');
 await new Promise(r=>setTimeout(r,4100));
});
