import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter, once} from 'node:events';
import {spawn} from 'node:child_process';
import test from 'node:test';
import {CollectorHeartbeat, CollectorSupervisor} from '../src/collector-health.mjs';

async function fixture({ignoreTerm = false} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'infobar-health-'));
  let now = 100000;
  const children = [], logs = [];
  const supervisor = new CollectorSupervisor({stateRoot:root, now:()=>now, intervalMs:1000000,
    timeoutMs:90000, stopGraceMs:10, log:message=>logs.push(message), start:env=>{
      const child = new EventEmitter();
      Object.assign(child, {pid:100 + children.length, exitCode:null, signalCode:null, env, signals:[]});
      child.kill = signal => {
        child.signals.push(signal);
        if (ignoreTerm && signal === 'SIGTERM') return true;
        queueMicrotask(()=>{child.signalCode=signal;child.emit('exit',null,signal);});
        return true;
      };
      children.push(child);
      return child;
    }});
  supervisor.ensureRunning();
  return {root, supervisor, children, logs,
    advance(ms) { now += ms; },
    async pulse(summary = {}) {
      const child = supervisor.child;
      const writer = new CollectorHeartbeat({file:child.env.CODEX_INFOBAR_HEARTBEAT_FILE,
        token:child.env.CODEX_INFOBAR_HEARTBEAT_TOKEN, pid:child.pid, now:()=>now});
      await writer.pulse('cycle-complete', {expected:1,mounted:1,...summary}, true);
    },
    async close() { await supervisor.stop(); await fs.rm(root,{recursive:true,force:true}); },
  };
}

test('heartbeat only saves bounded health metadata and preserves repeated progress updates', async () => {
  const f=await fixture();
  try {
    await f.pulse({expected:1,mounted:1,privateConversation:'secret'});
    await f.supervisor.check();
    assert.equal(f.supervisor.status().reason,'healthy');
    const raw=await fs.readFile(f.supervisor.session.file,'utf8');
    assert.doesNotMatch(raw,/privateConversation|secret/);
    f.advance(80000);await f.pulse();await f.supervisor.check();
    assert.equal(f.children.length,1);assert.equal(f.supervisor.recoveries,0);
  } finally {await f.close();}
});

test('stalled heartbeat retires only the owned child, escalates after grace, then starts a new session', async () => {
  const f=await fixture({ignoreTerm:true});
  try {
    await f.pulse();const old=f.supervisor.child;const oldFile=f.supervisor.session.file;
    f.advance(90001);await f.supervisor.check();
    assert.deepEqual(old.signals,['SIGTERM','SIGKILL']);
    assert.equal(f.supervisor.recoveries,1);
    assert.equal(f.supervisor.child,null);
    await f.supervisor.check();assert.equal(f.children.length,1,'backoff prevents immediate relaunch');
    f.advance(2001);await f.supervisor.check();
    assert.equal(f.children.length,2);assert.notEqual(f.supervisor.session.file,oldFile);
    await f.pulse();await f.supervisor.check();
    assert.equal(f.supervisor.status().reason,'healthy');
    assert.ok(f.logs.some(line=>line.includes('heartbeat-timeout')));
  } finally {await f.close();}
});

test('fresh loop heartbeats do not conceal a persistently unhealthy visible mount', async () => {
  const f=await fixture();
  try {
    await f.pulse({mounted:0,degradedSince:100000});
    f.advance(90001);await f.pulse({mounted:0,degradedSince:100000});
    await f.supervisor.check();
    assert.equal(f.supervisor.recoveries,1);
    assert.ok(f.logs.some(line=>line.includes('mount-timeout')));
  } finally {await f.close();}
});

test('missing, wrong-session and future heartbeats cannot keep a completed collector healthy', async () => {
  for(const kind of ['missing','wrong-session','future']){
    const f=await fixture();
    try{
      if(kind!=='missing'){
        await f.pulse();const file=f.supervisor.session.file;
        const value=JSON.parse(await fs.readFile(file,'utf8'));
        if(kind==='wrong-session'){value.pid=999;value.token='old-session';}
        else value.observedAt=1000000;
        await fs.writeFile(file,JSON.stringify(value));
      }
      await f.supervisor.check();assert.equal(f.supervisor.recoveries,0,'startup grace');
      f.advance(90001);await f.supervisor.check();
      assert.equal(f.supervisor.recoveries,1);
      assert.equal(f.children[0].pid,100);
      assert.deepEqual(f.children[0].signals,['SIGTERM']);
    }finally{await f.close();}
  }
});

test('no visible expected mount is healthy, and paused supervisors do not relaunch', async () => {
  const f=await fixture();
  try{
    f.advance(90001);await f.pulse({expected:0,mounted:0,degradedSince:null});
    await f.supervisor.check();assert.equal(f.supervisor.recoveries,0);
    f.supervisor.pause();f.advance(90001);await f.supervisor.check();
    f.advance(30000);await f.supervisor.check();assert.equal(f.children.length,1);
  }finally{await f.close();}
});

test('explicit shutdown cancels monitoring and cannot start another collector', async () => {
  const f=await fixture();
  try{
    await f.pulse();await f.supervisor.stop();f.advance(180000);
    await f.supervisor.check();f.supervisor.ensureRunning();
    assert.equal(f.children.length,1);
    assert.equal(f.supervisor.child,null);
    assert.equal(f.supervisor.status().reason,'stopped');
  }finally{await f.close();}
});

test('parent watchdog replaces a real live process after its heartbeat stalls', {timeout:20000}, async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'infobar-health-process-'));
  const moduleUrl=new URL('../src/collector-health.mjs',import.meta.url).href;
  const script=`
    import {CollectorHeartbeat} from ${JSON.stringify(moduleUrl)};
    const writer=new CollectorHeartbeat();
    await writer.pulse('cycle-complete',{expected:1,mounted:1},true);
    let stalled=false;
    async function beat(){
      if(stalled)return;
      await writer.pulse('cycle-complete',{expected:1,mounted:1},true);
      if(!stalled)setTimeout(beat,100);
    }
    setTimeout(beat,100);
    process.on('message',message=>{
      if(message==='stall'){stalled=true;setInterval(()=>{},10000);process.send('stalled');}
    });
    process.send('ready');
  `;
  const children=[];
  const supervisor=new CollectorSupervisor({stateRoot:root,timeoutMs:2000,intervalMs:30,stopGraceMs:200,
    start:env=>{const child=spawn(process.execPath,['--input-type=module','-e',script],{
      env:{...process.env,...env},stdio:['ignore','ignore','pipe','ipc'],
    });children.push(child);return child;}});
  try{
    supervisor.ensureRunning();const first=supervisor.child, firstToken=supervisor.session.token;
    const [message]=await once(first,'message',{signal:AbortSignal.timeout(5000)});
    assert.equal(message,'ready');
    first.send('stall');await once(first,'message',{signal:AbortSignal.timeout(5000)});
    const deadline=Date.now()+10000;
    while(Date.now()<deadline && !(supervisor.child && supervisor.child!==first && supervisor.status().reason==='healthy')){
      await new Promise(resolve=>setTimeout(resolve,30));
    }
    assert.equal(supervisor.recoveries,1);
    assert.equal(children.length,2);
    assert.notEqual(supervisor.child,first);
    assert.notEqual(supervisor.session.token,firstToken);
    assert.equal(supervisor.status().reason,'healthy');
  }finally{
    await supervisor.stop();await fs.rm(root,{recursive:true,force:true});
  }
});
