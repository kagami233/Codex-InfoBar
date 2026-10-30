import fs from 'node:fs/promises';
import path from 'node:path';

export const psLiteral = value => "'" + String(value).replaceAll("'", "''") + "'";
export function windowsArgument(value) {
  return '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}

export async function startWindowsDetached(executable, args, {cwd, env, run}) {
  const command = [executable, ...args].map(windowsArgument).join(' ');
  const environment = Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_()]*$/.test(key) || String(value).includes('\0')) throw new Error('Invalid service environment');
    return psLiteral(`${key}=${value}`);
  }).join(',');
  // WMI creates the process in the user's session independently of the installer
  // and its job/console. No credentials, task registration or administrator rights.
  const result = JSON.parse(await run(`$s=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0;CreateFlags=[uint32]0x01000000;EnvironmentVariables=[string[]]@(${environment})}; Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=${psLiteral(command)};CurrentDirectory=${psLiteral(cwd)};ProcessStartupInformation=$s}|Select-Object ProcessId,ReturnValue|ConvertTo-Json -Compress`));
  if (result.ReturnValue !== 0 || !Number.isInteger(result.ProcessId) || result.ProcessId < 1) {
    throw new Error(`Windows could not start the independent watcher (WMI ${result.ReturnValue}); service installation is incomplete`);
  }
  return result.ProcessId;
}

export async function requestWindowsQuit(executable, pid, run) {
  if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid process ID');
  const source = await fs.readFile(new URL('./windows-native.cs', import.meta.url), 'utf8');
  const result = Number(await run(`Add-Type -TypeDefinition ${psLiteral(source)}; [CodexInfoBar.WindowsQuit]::Request(${pid},${psLiteral(executable)})`, {timeout: 60000}));
  if (result !== 0) throw new Error(`Windows graceful shutdown declined (Restart Manager ${result}); no forced termination was attempted`);
  return true;
}

export async function retireWindowsWatcher(owner, lock, run) {
  if (!Number.isInteger(owner?.pid) || owner.pid < 1 || owner.pid===process.pid || path.win32.basename(owner.command).toLowerCase()!=='node.exe') throw new Error('Refusing to retire an unverified Node watcher');
  const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const program=script=>`^(?:"${escape(owner.command)}"|${escape(owner.command)})\\s+(?:"${escape(script)}"|${escape(script)})(?=\\s|$)`;
  if (!new RegExp(program(lock.script),'i').test(owner.args)) throw new Error('Watcher script is not the process entry point; refusing termination');
  const childPattern=program(path.join(path.dirname(lock.script),'cli.mjs'))+'\\s+attach(?:\\s|$)';
  await run(`
function Stop-VerifiedInfoBarProcess($row,$pattern){
 $p=Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue;if(!$p){return};
 try{
  $null=$p.Handle;
  $current=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$row.ProcessId);
  if(!$current){return};
  # CIM timestamps have microsecond precision; FILETIME also has sub-microsecond ticks.
  $createdDifference=[Math]::Abs($p.StartTime.ToUniversalTime().ToFileTimeUtc()-$row.CreationDate.ToUniversalTime().ToFileTimeUtc());
  if($p.Path -ine ${psLiteral(owner.command)} -or $current.CommandLine -cne $row.CommandLine -or $current.CommandLine -notmatch $pattern -or $createdDifference -ge 10){throw 'InfoBar process identity changed; refusing termination'};
  $p.Kill();if(!$p.WaitForExit(5000)){throw 'InfoBar process did not exit'};
 }finally{$p.Dispose()}
}
$parent=Get-CimInstance Win32_Process -Filter 'ProcessId = ${owner.pid}';
if($parent){
 if($parent.ExecutablePath -ine ${psLiteral(owner.command)} -or $parent.CommandLine -cne ${psLiteral(owner.args)}){throw 'Watcher identity changed'};
 foreach($child in @(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${owner.pid}')){
  if($child.ExecutablePath -ieq ${psLiteral(owner.command)} -and $child.CommandLine -match ${psLiteral(childPattern)}){Stop-VerifiedInfoBarProcess $child ${psLiteral(childPattern)}}
 }
 Stop-VerifiedInfoBarProcess $parent ${psLiteral(program(lock.script))};
}`);
}
