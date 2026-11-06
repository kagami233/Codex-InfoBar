using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace CodexInfoBar {
    [DataContract] public class LauncherSettings {
        [DataMember(Name="CODEX_INFOBAR_PORT")] public string Port;
    }
    [DataContract] public class LauncherConfig {
        [DataMember(Name="nodePath")] public string NodePath;
    }
    [DataContract] public class LauncherLock {
        [DataMember(Name="pid")] public int Pid;
        [DataMember(Name="script")] public string Script;
    }
    [DataContract] public class LauncherProbe {
        [DataMember] public string Executable;
        [DataMember] public int Port;
        [DataMember] public string Arguments;
        [DataMember] public int ExistingPid;
        [DataMember] public string ExistingState;
        [DataMember] public string ExistingPackageFamily;
    }
    public sealed class LauncherMain {public int Pid;public long Created;public string CommandLine;}
    public sealed class AmbiguousCodexMain : InvalidOperationException {public AmbiguousCodexMain():base("Multiple verified Codex main processes; no client was closed") {}}
    [DataContract] public class LauncherStatus {
        [DataMember] public string ObservedAt,Action,Executable;
        [DataMember] public string PackageFamily;
        [DataMember] public int Pid,Port,RequestedPid;
    }
    public static class StableLauncher {
        const string Family="OpenAI.Codex_2p2nqsd0c76g0";
        [ComImport,Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface ActivationManager {
            [PreserveSig]int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)]string appId,[MarshalAs(UnmanagedType.LPWStr)]string arguments,uint options,out uint pid);
            [PreserveSig]int ActivateForFile([MarshalAs(UnmanagedType.LPWStr)]string appId,IntPtr items,[MarshalAs(UnmanagedType.LPWStr)]string verb,out uint pid);
            [PreserveSig]int ActivateForProtocol([MarshalAs(UnmanagedType.LPWStr)]string appId,IntPtr items,out uint pid);
        }
        [DllImport("ole32.dll",PreserveSig=true)] static extern int CoCreateInstance(ref Guid clsid,IntPtr outer,uint context,ref Guid iid,out ActivationManager manager);
        delegate bool WindowVisitor(IntPtr window,IntPtr data);
        [DllImport("user32.dll")]static extern bool EnumWindows(WindowVisitor visit,IntPtr data);
        [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
        [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")]static extern IntPtr GetWindow(IntPtr window,uint command);
        [DllImport("user32.dll")]static extern int GetWindowLong(IntPtr window,int index);
        [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowTextLength(IntPtr window);
        [DllImport("user32.dll")]static extern bool ShowWindowAsync(IntPtr window,int command);
        [DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern int GetPackageFamilyName(IntPtr process,ref uint length,StringBuilder name);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern int GetPackagesByPackageFamily(string family, ref uint count, IntPtr names, ref uint length, IntPtr buffer);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern int GetPackagePathByFullName(string name, ref uint length, StringBuilder path);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern uint GetLongPathName(string path,StringBuilder result,uint length);
        [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct StartupInfo {
            public uint size;public string reserved,desktop,title;
            public uint x,y,xSize,ySize,xCountChars,yCountChars,fillAttribute,flags;
            public ushort showWindow,reservedSize;public IntPtr reservedData,input,output,error;
        }
        [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {public IntPtr process,thread;public uint pid,threadId;}
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string application,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inheritHandles,uint flags,IntPtr environment,string directory,ref StartupInfo startup,out ProcessInfo process);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("shell32.dll",CharSet=CharSet.Unicode)] static extern int SetCurrentProcessExplicitAppUserModelID(string id);
        static T Read<T>(string file) { using(var stream=File.OpenRead(file)) return (T)new DataContractJsonSerializer(typeof(T)).ReadObject(stream); }
        public static int ReadPort(string file) {
            int port;
            if(!Int32.TryParse(Read<LauncherSettings>(file).Port,out port)||port<1024||port>65535) throw new InvalidDataException("Invalid InfoBar debug port");
            return port;
        }
        public static string DebugArguments(int port) { return "--remote-debugging-address=127.0.0.1 --remote-debugging-port="+port; }
        public static int RequestedPort(string commandLine) {
            if(commandLine==null)return 0;
            var matches=Regex.Matches(commandLine,"(?:^|\\s)\"?--remote-debugging-port(?:=|\\s+)\"?(\\d+)\"?(?=\\s|$)",RegexOptions.IgnoreCase);
            int value;return matches.Count>0&&Int32.TryParse(matches[matches.Count-1].Groups[1].Value,out value)&&value>=1024&&value<=65535?value:0;
        }
        public static string ActivationState(LauncherMain main,int port) {
            return main==null?"not-running":main.CommandLine==null?"identity-unavailable":RequestedPort(main.CommandLine)==port?"debug-requested":"needs-debug-restart";
        }
        public static LauncherMain InspectMain(string executable) {
            LauncherMain found=null;
            using(var query=new ManagementObjectSearcher("SELECT ProcessId,ExecutablePath,CommandLine FROM Win32_Process WHERE Name='ChatGPT.exe'"))
            using(var rows=query.Get())foreach(ManagementObject row in rows){
                using(row){
                    string image=row["ExecutablePath"] as string,command=row["CommandLine"] as string;
                    if(!EqualPath(image,executable)||(command!=null&&Regex.IsMatch(command,"(?:^|\\s)--type(?:=|\\s)",RegexOptions.IgnoreCase)))continue;
                    if(found!=null)throw new AmbiguousCodexMain();
                    int pid=Convert.ToInt32(row["ProcessId"]);long created;
                    try{using(var process=Process.GetProcessById(pid))created=process.StartTime.ToUniversalTime().ToFileTimeUtc();}catch(ArgumentException){continue;}
                    found=new LauncherMain {Pid=pid,Created=created,CommandLine=command};
                }
            }
            return found;
        }
        public static bool RepairExisting(string executable,LauncherMain expected,bool confirmed) {
            // A confirmation is required for this one activation. Never save an
            // automatic restart preference or turn a cancelled prompt into approval.
            if(!confirmed)return false;
            if(expected==null||expected.Created==0)throw new InvalidOperationException("Missing process identity; no client was closed");
            var current=InspectMain(executable);
            if(current==null)return true;
            if(current.Pid!=expected.Pid||current.Created!=expected.Created||current.CommandLine!=expected.CommandLine)throw new InvalidOperationException("Codex changed while waiting for confirmation; no client was closed");
            int result=WindowsQuit.Request((uint)expected.Pid,executable,expected.Created);
            if(result!=0)throw new InvalidOperationException("Codex refused normal shutdown (Restart Manager "+result+"); no forced termination was attempted");
            var deadline=DateTime.UtcNow.AddSeconds(30);
            while(DateTime.UtcNow<deadline){
                current=InspectMain(executable);
                if(current==null)return true;
                if(current.Pid!=expected.Pid||current.Created!=expected.Created)throw new InvalidOperationException("Another Codex instance appeared; it was left open");
                System.Threading.Thread.Sleep(250);
            }
            throw new TimeoutException("Codex is still running after the normal shutdown request; it was not forced to close");
        }
        static void Record(string state,string action,string executable,int pid,int port,int requested) {
            var value=new LauncherStatus {ObservedAt=DateTime.UtcNow.ToString("o"),Action=action,Executable=executable,Pid=pid,Port=port,RequestedPid=requested};
            if(pid>0)try{value.PackageFamily=PackageFamily((uint)pid);}catch(System.ComponentModel.Win32Exception){}
            string file=Path.Combine(state,"launcher-status.json");
            string temp=file+"."+Process.GetCurrentProcess().Id+".tmp";
            try {
                using(var output=File.Create(temp))new DataContractJsonSerializer(typeof(LauncherStatus)).WriteObject(output,value);
                try{if(File.Exists(file))File.Replace(temp,file,null);else File.Move(temp,file);}catch(IOException){if(File.Exists(file)&&File.Exists(temp))File.Replace(temp,file,null);else throw;}
            }finally{if(File.Exists(temp))File.Delete(temp);}
            File.AppendAllText(Path.Combine(state,"launcher.log"),value.ObservedAt+" "+action+"; actualPid="+pid+"; requestedPid="+requested+"; port="+port+Environment.NewLine);
        }
        public static string SelectExecutable(string[] names,string[] roots) {
            if(names.Length!=roots.Length) throw new ArgumentException("Package list mismatch");
            Version best=null;string executable=null;
            for(int i=0;i<names.Length;i++) {
                string[] parts=names[i].Split('_');Version version;
                if(parts.Length!=5||parts[0]!="OpenAI.Codex"||parts[4]!="2p2nqsd0c76g0"||!Version.TryParse(parts[1],out version)) continue;
                string candidate=Path.Combine(roots[i],"app","ChatGPT.exe");
                if(File.Exists(candidate)&&(best==null||version.CompareTo(best)>0)) {best=version;executable=candidate;}
            }
            return executable;
        }
        public static string ResolveInstalledCodex() {
            for(int attempt=0;attempt<3;attempt++) {
                uint count=0,length=0;
                int result=GetPackagesByPackageFamily(Family,ref count,IntPtr.Zero,ref length,IntPtr.Zero);
                if(count==0) throw new FileNotFoundException("OpenAI.Codex is not installed for this user");
                if(result!=122) throw new System.ComponentModel.Win32Exception(result);
                IntPtr names=Marshal.AllocHGlobal(checked((int)count*IntPtr.Size)),buffer=Marshal.AllocHGlobal(checked((int)length*2));
                try {
                    result=GetPackagesByPackageFamily(Family,ref count,names,ref length,buffer);
                    if(result==122) continue;
                    if(result!=0) throw new System.ComponentModel.Win32Exception(result);
                    var registeredNames=new List<string>();var registeredRoots=new List<string>();
                    for(int i=0;i<count;i++) {
                        string name=Marshal.PtrToStringUni(Marshal.ReadIntPtr(names,i*IntPtr.Size));
                        uint size=0;if(GetPackagePathByFullName(name,ref size,null)!=122) continue;
                        var root=new StringBuilder((int)size);
                        if(GetPackagePathByFullName(name,ref size,root)!=0) continue;
                        registeredNames.Add(name);registeredRoots.Add(root.ToString());
                    }
                    string executable=SelectExecutable(registeredNames.ToArray(),registeredRoots.ToArray());
                    if(executable!=null) return executable;
                } finally {Marshal.FreeHGlobal(names);Marshal.FreeHGlobal(buffer);}
            }
            throw new FileNotFoundException("No registered Codex package has app/ChatGPT.exe; retry after the update completes");
        }
        static string CanonicalPath(string path) {
            path=Path.GetFullPath(path);var result=new StringBuilder(32768);
            uint length=GetLongPathName(path,result,(uint)result.Capacity);
            return length>0&&length<result.Capacity?result.ToString():path;
        }
        static bool EqualPath(string a,string b) {return a!=null&&b!=null&&String.Equals(CanonicalPath(a),CanonicalPath(b),StringComparison.OrdinalIgnoreCase);}
        public static string PackageFamily(uint pid) {
            IntPtr process=OpenProcess(0x1000,false,pid);if(process==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            try{uint length=0;int result=GetPackageFamilyName(process,ref length,null);if(result==15700)return null;if(result!=122)throw new System.ComponentModel.Win32Exception(result);var name=new StringBuilder((int)length);result=GetPackageFamilyName(process,ref length,name);if(result!=0)throw new System.ComponentModel.Win32Exception(result);return name.ToString();}finally{CloseHandle(process);}
        }
        public static int ActivatePackagedApplication(string appId,string arguments) {
            var clsid=new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C");var iid=typeof(ActivationManager).GUID;ActivationManager manager;
            // A short-lived launcher must use the out-of-process COM server so
            // Windows owns activation arguments after this helper exits.
            Marshal.ThrowExceptionForHR(CoCreateInstance(ref clsid,IntPtr.Zero,4,ref iid,out manager));
            try{uint pid;Marshal.ThrowExceptionForHR(manager.ActivateApplication(appId,arguments,2,out pid));return checked((int)pid);}finally{Marshal.ReleaseComObject(manager);}
        }
        static IntPtr MainWindow(int pid) {
            IntPtr visible=IntPtr.Zero,hidden=IntPtr.Zero;
            EnumWindows(delegate(IntPtr window,IntPtr data){uint owner;GetWindowThreadProcessId(window,out owner);int exStyle=GetWindowLong(window,-20),style=GetWindowLong(window,-16);
                if(owner!=(uint)pid||GetWindow(window,4)!=IntPtr.Zero||(exStyle&0x80)!=0||GetWindowTextLength(window)==0||(style&0x00C40000)==0)return true;
                if(IsWindowVisible(window)){visible=window;return false;}if((exStyle&0x40000)!=0)hidden=window;return true;
            },IntPtr.Zero);return visible!=IntPtr.Zero?visible:hidden;
        }
        public static bool WaitForExistingWindowOrExit(string executable,LauncherMain expected,int milliseconds) {
            if(expected==null||expected.Created==0)throw new InvalidOperationException("Missing existing process identity");
            Process process;try{process=Process.GetProcessById(expected.Pid);}catch(ArgumentException){return false;}
            using(process){
                long created;try{created=process.StartTime.ToUniversalTime().ToFileTimeUtc();}catch(InvalidOperationException){if(process.HasExited)return false;throw;}
                if(created!=expected.Created)throw new InvalidOperationException("Existing process identity changed");
                var deadline=DateTime.UtcNow.AddMilliseconds(milliseconds);
                while(!process.HasExited){
                    if(MainWindow(expected.Pid)!=IntPtr.Zero)return true;
                    if(DateTime.UtcNow>=deadline)return true; // A stable background instance may need package activation to create a window.
                    process.WaitForExit(100);
                }
                return false; // It exited on its own. No shutdown request is sent.
            }
        }
        public static bool ActivateExistingWindow(string executable,LauncherMain expected) {
            var current=InspectMain(executable);if(current==null||current.Pid!=expected.Pid||current.Created!=expected.Created)return false;
            IntPtr window=MainWindow(expected.Pid);if(window==IntPtr.Zero)return false;
            ShowWindowAsync(window,9);SetForegroundWindow(window);return true;
        }
        static void EnsureWatcher(string state) {
            state=CanonicalPath(state);
            var config=Read<LauncherConfig>(Path.Combine(state,"launcher","config.json"));
            config.NodePath=CanonicalPath(config.NodePath);
            string script=Path.Combine(state,"runtime","src","watcher.mjs");
            if(!File.Exists(config.NodePath)||!File.Exists(script)||!String.Equals(Path.GetFileName(config.NodePath),"node.exe",StringComparison.OrdinalIgnoreCase)) throw new FileNotFoundException("Reinstall InfoBar: its Node runtime or watcher is missing");
            try {
                var owner=Read<LauncherLock>(Path.Combine(state,"watcher-lock.json"));
                if(owner.Pid>0&&EqualPath(owner.Script,script)) {
                    using(var row=new ManagementObject("Win32_Process.Handle='"+owner.Pid+"'")) {
                        row.Get();string command=row["CommandLine"] as string;
                        string pattern="^\\s*\"?"+Regex.Escape(config.NodePath)+"\"?\\s+\"?"+Regex.Escape(script)+"\"?(?:\\s|$)";
                        if(EqualPath(row["ExecutablePath"] as string,config.NodePath)&&command!=null&&Regex.IsMatch(command,pattern,RegexOptions.IgnoreCase)) return;
                    }
                }
            } catch(IOException) {} catch(ManagementException) {} catch(SerializationException) {}
            // A detached console and no inherited handles keep the watcher
            // independent of a launcher/terminal's lifetime or output pipes.
            Environment.SetEnvironmentVariable("CODEX_INFOBAR_STATE",state);
            var startup=new StartupInfo {size=(uint)Marshal.SizeOf(typeof(StartupInfo)),flags=1,showWindow=0};
            ProcessInfo child;
            if(!CreateProcess(config.NodePath,new StringBuilder("\""+config.NodePath+"\" \""+script+"\""),IntPtr.Zero,IntPtr.Zero,false,8,IntPtr.Zero,Path.Combine(state,"runtime"),ref startup,out child)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            CloseHandle(child.thread);CloseHandle(child.process);
        }
        [STAThread] public static int Main(string[] args) {
            string state=Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,".."));
            bool probe=args.Length==1&&args[0]=="--probe";
            bool login=args.Length==1&&args[0]=="--login";
            try {
                if(args.Length>0&&!probe&&!login) throw new ArgumentException("This launcher accepts only --probe, --login or no arguments");
                if(!probe)Marshal.ThrowExceptionForHR(SetCurrentProcessExplicitAppUserModelID("local.codex.infobar.launcher"));
                string executable=ResolveInstalledCodex();int port=ReadPort(Path.Combine(state,"settings.json"));
                LauncherMain existing=InspectMain(executable);string existingState=ActivationState(existing,port);
                if(probe) {
                    var result=new LauncherProbe {Executable=executable,Port=port,Arguments=DebugArguments(port),ExistingPid=existing==null?0:existing.Pid,ExistingState=existingState,ExistingPackageFamily=existing==null?null:PackageFamily((uint)existing.Pid)};
                    using(var output=Console.OpenStandardOutput()) new DataContractJsonSerializer(typeof(LauncherProbe)).WriteObject(output,result);
                    return 0;
                }
                string mutexName;using(var hash=System.Security.Cryptography.SHA256.Create())mutexName="Local\\CodexInfoBar.Activation."+BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(CanonicalPath(state).ToLowerInvariant()))).Replace("-","");
                using(var activation=new System.Threading.Mutex(false,mutexName)){
                bool acquired=false;try{
                try{acquired=activation.WaitOne(20000);}catch(System.Threading.AbandonedMutexException){acquired=true;}
                if(!acquired){Record(state,"activation-busy",executable,0,port,0);return 3;}
                existing=InspectMain(executable);existingState=ActivationState(existing,port);
                try {EnsureWatcher(state);}catch(Exception error){File.AppendAllText(Path.Combine(state,"launcher.log"),DateTime.UtcNow.ToString("o")+" Watcher recovery failed: "+error.Message+Environment.NewLine);}
                if(existing!=null){
                    int previous=existing.Pid;
                    if(!WaitForExistingWindowOrExit(executable,existing,15000))Record(state,"previous-instance-exited",executable,previous,port,0);
                    existing=InspectMain(executable);existingState=ActivationState(existing,port);
                }
                if(existingState=="identity-unavailable"){
                    Record(state,existingState,executable,existing.Pid,port,0);
                    if(login)return 2;
                    MessageBox.Show("无法验证当前 Codex 的启动参数（PID "+existing.Pid+"）。\n请保存工作后完全退出 Codex，再点击现有任务栏图标。当前聊天将保持打开。","Codex-InfoBar",MessageBoxButtons.OK,MessageBoxIcon.Information);
                    return 2;
                }
                if(existingState=="needs-debug-restart"){
                    Record(state,existingState,executable,existing.Pid,port,0);
                    if(login)return 2; // Login never closes an existing client or opens a modal.
                    var answer=MessageBox.Show("当前 Codex 未开启 InfoBar 调试连接（PID "+existing.Pid+"）。这可能发生在客户端升级或其他入口先启动后，无法在运行中补加参数。\n\n是否已保存工作，允许现在正常退出并重新打开 Codex，以恢复 InfoBar？\n选择“否”会保留当前会话；客户端拒绝退出时不会强制结束。","Codex-InfoBar：保存后正常重开",MessageBoxButtons.YesNo,MessageBoxIcon.Information,MessageBoxDefaultButton.Button2);
                    if(!RepairExisting(executable,existing,answer==DialogResult.Yes)){Record(state,"repair-deferred",executable,existing.Pid,port,0);return 2;}
                    Record(state,"repair-normal-exit",executable,0,port,0);
                    executable=ResolveInstalledCodex();port=ReadPort(Path.Combine(state,"settings.json"));existing=null;
                }
                if(existingState=="debug-requested"){
                    if(login){Record(state,"existing-running",executable,existing.Pid,port,0);return 0;}
                    if(ActivateExistingWindow(executable,existing)){Record(state,"existing-activated",executable,existing.Pid,port,0);return 0;}
                    // If a window disappeared during activation, wait for that
                    // process to finish before sending a launch to the package.
                    if(!WaitForExistingWindowOrExit(executable,existing,15000)){Record(state,"previous-instance-exited",executable,existing.Pid,port,0);existing=null;}
                }
                using(var bootstrap=WindowsWindowBootstrap.TryStart(executable,state,Path.Combine(state,"launcher","CodexInfoBarLauncher.exe"),Path.Combine(state,"launcher","ChatGPT.ico"))){
                int requested=ActivatePackagedApplication(Family+"!App",DebugArguments(port));
                if(bootstrap!=null)bootstrap.SetTarget(requested);
                Record(state,"activation-requested",executable,existing==null?0:existing.Pid,port,requested);
                var deadline=DateTime.UtcNow.AddSeconds(20);
                while(DateTime.UtcNow<deadline){
                    LauncherMain actual;try{actual=InspectMain(executable);}catch(AmbiguousCodexMain){System.Threading.Thread.Sleep(250);continue;}
                    if(actual!=null){
                        string actualState=ActivationState(actual,port);
                        if(actualState!="debug-requested")throw new InvalidOperationException("Codex activation reused or created a process without the configured debug port (PID "+actual.Pid+"). Save work and fully quit it before retrying.");
                        if(existing==null&&PackageFamily((uint)actual.Pid)!=Family){System.Threading.Thread.Sleep(250);continue;}
                        if(bootstrap!=null){bootstrap.SetTarget(actual.Pid);bool early=bootstrap.WaitForFirstRoute(15000);File.AppendAllText(Path.Combine(state,"launcher.log"),DateTime.UtcNow.ToString("o")+" Early window routing: ready="+early+"; updates="+bootstrap.Updates+"; pid="+actual.Pid+"; error="+bootstrap.LastError+Environment.NewLine);if(early)System.Threading.Thread.Sleep(300);}
                        Record(state,"debug-starting",executable,actual.Pid,port,requested);return 0;
                    }
                    System.Threading.Thread.Sleep(250);
                }
                throw new TimeoutException("No verified debug-enabled Codex main process appeared; no client was closed");
                }
                }finally{if(acquired)activation.ReleaseMutex();}
                }
            } catch(Exception error) {
                try {File.AppendAllText(Path.Combine(state,"launcher.log"),DateTime.UtcNow.ToString("o")+" "+error+Environment.NewLine);} catch(IOException) {}
                if(probe) Console.Error.WriteLine(error.Message);
                else if(!login)MessageBox.Show("Codex-InfoBar 未能完成启动或恢复。当前客户端不会被强制结束。\n"+error.Message+"\n日志："+Path.Combine(state,"launcher.log"),"Codex-InfoBar",MessageBoxButtons.OK,MessageBoxIcon.Error);
                return 1;
            }
        }
    }
}
