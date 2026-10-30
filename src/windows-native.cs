using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace CodexInfoBar {
    public static class WindowsQuit {
        [StructLayout(LayoutKind.Sequential)] struct UniqueProcess {
            public uint pid;
            public System.Runtime.InteropServices.ComTypes.FILETIME started;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct ProcessInfo {
            public UniqueProcess process;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string name;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string service;
            public uint type, status, session;
            [MarshalAs(UnmanagedType.Bool)] public bool restartable;
        }
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr handle, out System.Runtime.InteropServices.ComTypes.FILETIME created, out System.Runtime.InteropServices.ComTypes.FILETIME exited, out System.Runtime.InteropServices.ComTypes.FILETIME kernel, out System.Runtime.InteropServices.ComTypes.FILETIME user);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder name, ref uint size);
        [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint session, uint flags, StringBuilder key);
        [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint session, uint files, string[] names, uint applications, UniqueProcess[] processes, uint services, string[] serviceNames);
        [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmGetList(uint session, out uint needed, ref uint count, [In, Out] ProcessInfo[] processes, ref uint reasons);
        [DllImport("rstrtmgr.dll")] static extern int RmShutdown(uint session, uint flags, IntPtr callback);
        [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint session);

        public static int Request(uint pid, string expectedExecutable) {
            // Query rights only: this code never opens a process with termination rights.
            IntPtr handle = OpenProcess(0x1000, false, pid);
            if (handle == IntPtr.Zero) {
                int error = Marshal.GetLastWin32Error();
                if (error == 87) return 0; // Already exited.
                throw new Win32Exception(error);
            }
            try {
                var image = new StringBuilder(32768); uint size = (uint)image.Capacity;
                if (!QueryFullProcessImageName(handle, 0, image, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
                if (!String.Equals(image.ToString(), expectedExecutable, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Process identity changed; refusing shutdown");
                System.Runtime.InteropServices.ComTypes.FILETIME created, exited, kernel, user;
                if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) throw new Win32Exception(Marshal.GetLastWin32Error());
                var target = new UniqueProcess { pid = pid, started = created };
                uint session; int result = RmStartSession(out session, 0, new StringBuilder(33));
                if (result != 0) throw new Win32Exception(result);
                try {
                    result = RmRegisterResources(session, 0, null, 1, new[] { target }, 0, null);
                    if (result != 0) throw new Win32Exception(result);
                    uint needed, count = 0, reasons = 0;
                    result = RmGetList(session, out needed, ref count, null, ref reasons);
                    if (result == 0 && needed == 0) return 0;
                    if (result != 234 || needed != 1) throw new InvalidOperationException("Unexpected Restart Manager target list; refusing shutdown");
                    var rows = new ProcessInfo[needed]; count = needed;
                    result = RmGetList(session, out needed, ref count, rows, ref reasons);
                    if (result != 0) throw new Win32Exception(result);
                    if (count != 1 || rows[0].process.pid != pid || rows[0].process.started.dwLowDateTime != created.dwLowDateTime || rows[0].process.started.dwHighDateTime != created.dwHighDateTime) throw new InvalidOperationException("Restart Manager process identity changed");
                    // Zero flags means graceful shutdown, including applications that hide
                    // on WM_CLOSE. A shutdown veto is respected. Never RmForceShutdown.
                    return RmShutdown(session, 0, IntPtr.Zero);
                } finally { RmEndSession(session); }
            } finally { CloseHandle(handle); }
        }
    }
}
