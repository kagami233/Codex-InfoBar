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
    }
    public static class StableLauncher {
        const string Family="OpenAI.Codex_2p2nqsd0c76g0";
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
        static T Read<T>(string file) { using(var stream=File.OpenRead(file)) return (T)new DataContractJsonSerializer(typeof(T)).ReadObject(stream); }
        public static int ReadPort(string file) {
            int port;
            if(!Int32.TryParse(Read<LauncherSettings>(file).Port,out port)||port<1024||port>65535) throw new InvalidDataException("Invalid InfoBar debug port");
            return port;
        }
        public static string DebugArguments(int port) { return "--remote-debugging-address=127.0.0.1 --remote-debugging-port="+port; }
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
            try {
                if(args.Length>0&&!probe) throw new ArgumentException("This launcher accepts only --probe or no arguments");
                string executable=ResolveInstalledCodex();int port=ReadPort(Path.Combine(state,"settings.json"));
                if(probe) {
                    var result=new LauncherProbe {Executable=executable,Port=port,Arguments=DebugArguments(port)};
                    using(var output=Console.OpenStandardOutput()) new DataContractJsonSerializer(typeof(LauncherProbe)).WriteObject(output,result);
                    return 0;
                }
                try {EnsureWatcher(state);}catch(Exception error){File.AppendAllText(Path.Combine(state,"launcher.log"),DateTime.UtcNow.ToString("o")+" Watcher recovery failed: "+error.Message+Environment.NewLine);}
                var start=new ProcessStartInfo(executable,DebugArguments(port));
                start.UseShellExecute=false;start.WorkingDirectory=Path.GetDirectoryName(executable);
                Process.Start(start).Dispose();
                File.AppendAllText(Path.Combine(state,"launcher.log"),DateTime.UtcNow.ToString("o")+" Started "+executable+" on loopback port "+port+Environment.NewLine);
                return 0;
            } catch(Exception error) {
                try {File.AppendAllText(Path.Combine(state,"launcher.log"),DateTime.UtcNow.ToString("o")+" "+error+Environment.NewLine);} catch(IOException) {}
                if(probe) Console.Error.WriteLine(error.Message);
                else MessageBox.Show("Codex-InfoBar 无法启动 Codex。请等待客户端更新完成后重试。\n"+error.Message+"\n日志："+Path.Combine(state,"launcher.log"),"Codex-InfoBar",MessageBoxButtons.OK,MessageBoxIcon.Error);
                return 1;
            }
        }
    }
}
