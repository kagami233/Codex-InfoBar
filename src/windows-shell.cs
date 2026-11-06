using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace CodexInfoBar {
    public sealed class ShellWindow {
        public long Handle;public uint Pid;public string Created,Executable;
        public Dictionary<string,string> Values;
    }
    public static class WindowsShellRoute {
        [StructLayout(LayoutKind.Sequential)] struct Key {public Guid format;public uint id;public Key(uint value){format=new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");id=value;}}
        [StructLayout(LayoutKind.Sequential)] struct Value {public ushort kind,a,b,c;public IntPtr text,other;}
        [ComImport,Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface Store {
            [PreserveSig]int GetCount(out uint count);[PreserveSig]int GetAt(uint index,out Key key);[PreserveSig]int GetValue(ref Key key,out Value value);
            [PreserveSig]int SetValue(ref Key key,ref Value value);[PreserveSig]int Commit();
        }
        [DllImport("shell32.dll",PreserveSig=true)] static extern int SHGetPropertyStoreForWindow(IntPtr window,ref Guid id,out Store store);
        [DllImport("shell32.dll",CharSet=CharSet.Unicode,PreserveSig=true)] static extern int SHGetPropertyStoreFromParsingName(string file,IntPtr context,uint flags,ref Guid id,out Store store);
        [DllImport("ole32.dll")] static extern int PropVariantClear(ref Value value);
        [DllImport("propsys.dll",CharSet=CharSet.Unicode)] static extern int PSGetPropertyKeyFromName(string name,out Key key);
        [DllImport("shell32.dll",CharSet=CharSet.Unicode)] static extern void SHChangeNotify(uint change,uint flags,string path,IntPtr other);
        delegate bool Visit(IntPtr window,IntPtr data);
        [DllImport("user32.dll")] static extern bool EnumWindows(Visit visit,IntPtr data);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr window,int index);
        [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder path,ref uint size);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
        static readonly string[] Names={"relaunch","displayName","icon","appId"};
        static readonly uint[] Ids={2,4,3,5}; // App ID last notifies Explorer after all relaunch properties exist.
        static string Identity(uint pid,string executable) {
            IntPtr process=OpenProcess(0x1000,false,pid);
            if(process==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            try {
                var path=new StringBuilder(32768);uint size=(uint)path.Capacity;
                if(!QueryFullProcessImageName(process,0,path,ref size))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                if(!String.Equals(path.ToString(),executable,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Shell route process identity changed");
                long created,exited,kernel,user;
                if(!GetProcessTimes(process,out created,out exited,out kernel,out user))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                return created.ToString(System.Globalization.CultureInfo.InvariantCulture);
            } finally {CloseHandle(process);}
        }
        static string Read(Store store,uint id) {
            var key=new Key(id);Value value;Marshal.ThrowExceptionForHR(store.GetValue(ref key,out value));
            try {if(value.kind==0)return null;if(value.kind==31)return Marshal.PtrToStringUni(value.text);if(value.kind==8)return Marshal.PtrToStringBSTR(value.text);throw new InvalidOperationException("Unsupported Shell property type");}
            finally {PropVariantClear(ref value);}
        }
        static Dictionary<string,string> Read(Store store) {var result=new Dictionary<string,string>();for(int i=0;i<Ids.Length;i++)result[Names[i]]=Read(store,Ids[i]);return result;}
        static void Write(Store store,Dictionary<string,string> values) {
            for(int i=0;i<Ids.Length;i++) {
                var key=new Key(Ids[i]);string text;values.TryGetValue(Names[i],out text);
                var value=new Value();if(text!=null){value.kind=31;value.text=Marshal.StringToCoTaskMemUni(text);}
                try {Marshal.ThrowExceptionForHR(store.SetValue(ref key,ref value));}finally {PropVariantClear(ref value);}
            }
            Marshal.ThrowExceptionForHR(store.Commit());
        }
        public static Dictionary<string,string> Route(string launcher,string displayName,string icon) {
            return new Dictionary<string,string>{{"appId","local.codex.infobar.launcher"},{"relaunch","\""+launcher+"\""},{"displayName",displayName},{"icon",icon}};
        }
        public static Dictionary<string,string> Values(string relaunch,string displayName,string icon,string appId) {
            return new Dictionary<string,string>{{"relaunch",String.IsNullOrEmpty(relaunch)?null:relaunch},{"displayName",String.IsNullOrEmpty(displayName)?null:displayName},{"icon",String.IsNullOrEmpty(icon)?null:icon},{"appId",String.IsNullOrEmpty(appId)?null:appId}};
        }
        public static bool Equal(Dictionary<string,string> a,Dictionary<string,string> b) {
            foreach(string key in Names){string left,right;a.TryGetValue(key,out left);b.TryGetValue(key,out right);if(left!=right)return false;}return true;
        }
        public static List<ShellWindow> Inspect(uint pid,string executable) {
            string created=Identity(pid,executable);var rows=new List<ShellWindow>();
            EnumWindows(delegate(IntPtr window,IntPtr data){uint owner;GetWindowThreadProcessId(window,out owner);
                int style=GetWindowLong(window,-20);
                if(owner!=pid||(style&0x80)!=0||(!IsWindowVisible(window)&&(style&0x40000)==0))return true;
                var id=typeof(Store).GUID;Store store;Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(window,ref id,out store));
                try {rows.Add(new ShellWindow {Handle=window.ToInt64(),Pid=pid,Created=created,Executable=executable,Values=Read(store)});}finally{Marshal.ReleaseComObject(store);}return true;
            },IntPtr.Zero);return rows;
        }
        public static ShellWindow CaptureCreatedWindow(long handle,string executable) {
            var window=new IntPtr(handle);uint pid;GetWindowThreadProcessId(window,out pid);
            int style=GetWindowLong(window,-16),extended=GetWindowLong(window,-20);
            if(pid==0||(style&0x40000000)!=0||(extended&0x80)!=0||(style&0x00C40000)==0)return null;
            string created=Identity(pid,executable);var id=typeof(Store).GUID;Store store;
            Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(window,ref id,out store));
            try{return new ShellWindow {Handle=handle,Pid=pid,Created=created,Executable=executable,Values=Read(store)};}finally{Marshal.ReleaseComObject(store);}
        }
        public static bool SetWindow(uint pid,string executable,string created,long handle,Dictionary<string,string> expected,Dictionary<string,string> desired) {
            if(Identity(pid,executable)!=created)throw new InvalidOperationException("Shell route PID was reused");
            var window=new IntPtr(handle);uint owner;GetWindowThreadProcessId(window,out owner);if(owner!=pid)return false;
            var id=typeof(Store).GUID;Store store;Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(window,ref id,out store));
            try {if(!Equal(Read(store),expected))return false;Write(store,desired);return Equal(Read(store),desired);}finally{Marshal.ReleaseComObject(store);}
        }
        public static Dictionary<string,string> ReadShortcut(string file) {
            var id=typeof(Store).GUID;Store store;Marshal.ThrowExceptionForHR(SHGetPropertyStoreFromParsingName(file,IntPtr.Zero,0,ref id,out store));
            try{return Read(store);}finally{Marshal.ReleaseComObject(store);}
        }
        public static bool SetShortcut(string file,Dictionary<string,string> expected,Dictionary<string,string> desired) {
            var id=typeof(Store).GUID;Store store;Marshal.ThrowExceptionForHR(SHGetPropertyStoreFromParsingName(file,IntPtr.Zero,2,ref id,out store));
            bool result;
            try{
                if(!Equal(Read(store),expected))return false;
                if(desired["appId"]=="local.codex.infobar.launcher"&&expected["appId"]!=desired["appId"]){
                    // The helper is an independent desktop app, not the original
                    // packaged app's notification COM activation endpoint.
                    Key toast;Marshal.ThrowExceptionForHR(PSGetPropertyKeyFromName("System.AppUserModel.ToastActivatorCLSID",out toast));
                    var empty=new Value();Marshal.ThrowExceptionForHR(store.SetValue(ref toast,ref empty));
                }
                Write(store,desired);result=Equal(Read(store),desired);
            }finally{Marshal.ReleaseComObject(store);}
            if(result)SHChangeNotify(0x2000,0x1005,file,IntPtr.Zero);
            return result;
        }
    }
}
