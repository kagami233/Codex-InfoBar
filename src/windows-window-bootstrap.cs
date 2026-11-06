using System;using System.IO;using System.Collections.Generic;using System.Runtime.InteropServices;using System.Runtime.Serialization;using System.Runtime.Serialization.Json;using System.Threading;using System.Windows.Forms;
namespace CodexInfoBar {
 [DataContract] public sealed class BootstrapWindow {
  [DataMember]public long Handle;[DataMember]public uint Pid;[DataMember]public string Created;
  [DataMember]public Dictionary<string,string> original,applied;
  [DataMember]public string Source,CapturedAt,AppliedAt;[DataMember]public bool VisibleWhenCaptured;
 }
 [DataContract] public sealed class BootstrapJournal {
  [DataMember]public int version=1;[DataMember]public List<BootstrapWindow> entries=new List<BootstrapWindow>();
 }
 public sealed class WindowsWindowBootstrap:IDisposable {
  delegate void WindowEvent(IntPtr hook,uint kind,IntPtr window,int objectId,int childId,uint thread,uint time);
  [DllImport("user32.dll",SetLastError=true)]static extern IntPtr SetWinEventHook(uint first,uint last,IntPtr module,WindowEvent callback,uint process,uint thread,uint flags);
  [DllImport("user32.dll")]static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
  [DllImport("user32.dll")]static extern bool PostThreadMessage(uint thread,uint message,IntPtr w,IntPtr l);
  [DllImport("kernel32.dll")]static extern uint GetCurrentThreadId();
  readonly string executable,stateRoot,launcher,icon;readonly Thread worker;
  readonly ManualResetEvent ready=new ManualResetEvent(false),routed=new ManualResetEvent(false);
  readonly Dictionary<string,BootstrapJournal> journals=new Dictionary<string,BootstrapJournal>();
  WindowEvent callback;GCHandle callbackHandle;IntPtr hook;uint threadId;volatile int targetPid;volatile bool disposed;bool busy;
  public string LastError;public int Updates;public bool Armed;
  public WindowsWindowBootstrap(string executable,string stateRoot,string launcher,string icon){
   this.executable=executable;this.stateRoot=stateRoot;this.launcher=launcher;this.icon=icon;
   worker=new Thread(Run);worker.IsBackground=true;worker.SetApartmentState(ApartmentState.STA);worker.Start();
   if(!ready.WaitOne(5000)){Dispose();throw new TimeoutException("Window routing observer did not become ready");}
   if(!Armed){Dispose();throw new InvalidOperationException(LastError??"Window routing observer unavailable");}
  }
  public static WindowsWindowBootstrap TryStart(string executable,string stateRoot,string launcher,string icon){
   try{return new WindowsWindowBootstrap(executable,stateRoot,launcher,icon);}catch(Exception error){try{File.AppendAllText(Path.Combine(stateRoot,"launcher.log"),DateTime.UtcNow.ToString("o")+" Early window routing unavailable: "+error.Message+Environment.NewLine);}catch(IOException){}return null;}
  }
  public void SetTarget(int pid){targetPid=pid;}
  public bool WaitForFirstRoute(int milliseconds){return routed.WaitOne(milliseconds);}
  void Save(string key,BootstrapJournal journal){
   string directory=Path.Combine(stateRoot,"shell-bootstrap");Directory.CreateDirectory(directory);
   string file=Path.Combine(directory,key+".json"),temp=file+".tmp";
   var serializer=new DataContractJsonSerializer(typeof(BootstrapJournal),new DataContractJsonSerializerSettings {UseSimpleDictionaryFormat=true});
   using(var output=File.Create(temp))serializer.WriteObject(output,journal);
   if(File.Exists(file))File.Replace(temp,file,null);else File.Move(temp,file);
  }
  void Route(long handle,string source){
   if(busy||disposed)return;busy=true;
   try{
    uint pid;GetWindowThreadProcessId(new IntPtr(handle),out pid);if(pid==0||(targetPid!=0&&pid!=(uint)targetPid))return;
    var row=WindowsShellRoute.CaptureCreatedWindow(handle,executable);if(row==null)return;
    string appId=row.Values["appId"];if(appId!=null&&appId!="com.openai.codex"&&appId!="OpenAI.Codex_2p2nqsd0c76g0!App"&&appId!="local.codex.infobar.launcher")return;
    var desired=WindowsShellRoute.Route(launcher,"ChatGPT",icon+",0");
    if(WindowsShellRoute.Equal(row.Values,desired)){routed.Set();return;}
    string key=row.Pid+"-"+row.Created;BootstrapJournal journal;if(!journals.TryGetValue(key,out journal)){journal=new BootstrapJournal();journals.Add(key,journal);}
    var entry=journal.entries.Find(e=>e.Handle==row.Handle);
    if(entry!=null&&!WindowsShellRoute.Equal(row.Values,entry.original)&&!WindowsShellRoute.Equal(row.Values,entry.applied))return;
    if(entry==null){entry=new BootstrapWindow {Handle=row.Handle,Pid=row.Pid,Created=row.Created,original=row.Values,applied=desired,Source=source,CapturedAt=DateTime.UtcNow.ToString("o"),VisibleWhenCaptured=IsWindowVisible(new IntPtr(handle))};journal.entries.Add(entry);Save(key,journal);}
    // Save original properties before touching the window. The background
    // service imports this journal, so uninstall can restore the true originals.
    if(WindowsShellRoute.SetWindow(row.Pid,executable,row.Created,row.Handle,row.Values,desired)){entry.AppliedAt=DateTime.UtcNow.ToString("o");Save(key,journal);Interlocked.Increment(ref Updates);routed.Set();}
   }catch(InvalidOperationException){}catch(System.ComponentModel.Win32Exception){}catch(Exception error){LastError=error.Message;}finally{busy=false;}
  }
  void Run(){
   System.Windows.Forms.Timer timer=null;
   try{
    threadId=GetCurrentThreadId();callback=delegate(IntPtr h,uint kind,IntPtr window,int objectId,int childId,uint tid,uint time){if((kind==0x8000||kind==0x8002)&&objectId==0&&childId==0&&window!=IntPtr.Zero)Route(window.ToInt64(),kind==0x8000?"create":"show");};
    callbackHandle=GCHandle.Alloc(callback);hook=SetWinEventHook(0x8000,0x8002,IntPtr.Zero,callback,0,0,2); // OUTOFCONTEXT | SKIPOWNPROCESS: no injection.
    if(hook==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    timer=new System.Windows.Forms.Timer();timer.Interval=100;timer.Tick+=delegate{int pid=targetPid;if(pid<=0)return;try{foreach(var row in WindowsShellRoute.Inspect((uint)pid,executable))Route(row.Handle,"scan");}catch(Exception error){LastError=error.Message;}};
    timer.Start();Armed=true;ready.Set();if(!disposed)Application.Run();
   }catch(Exception error){LastError=error.Message;ready.Set();}finally{Armed=false;if(timer!=null)timer.Dispose();if(hook!=IntPtr.Zero)UnhookWinEvent(hook);if(callbackHandle.IsAllocated)callbackHandle.Free();}
  }
  public void Dispose(){if(disposed)return;disposed=true;if(threadId!=0)PostThreadMessage(threadId,0x12,IntPtr.Zero,IntPtr.Zero);if(Thread.CurrentThread!=worker)worker.Join(5000);}
 }
}
