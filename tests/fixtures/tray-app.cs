using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

public sealed class InfoBarTrayFixture : Form {
    readonly string log;
    readonly bool veto;
    public InfoBarTrayFixture(string file, bool refuse) {
        log = file; veto = refuse;
        ShowInTaskbar = true;
        StartPosition = FormStartPosition.Manual;
        Location = new Point(-10000, -10000);
        Text = "Codex-InfoBar isolated lifecycle test";
        Shown += delegate { File.AppendAllText(log, "ready:" + Handle.ToInt64() + "\n"); };
    }
    protected override void WndProc(ref Message message) {
        if (message.Msg == 0x0010) { // Tray-like apps hide instead of exiting.
            File.AppendAllText(log, "close-hidden\n"); Hide(); return;
        }
        if (message.Msg == 0x0011) {
            File.AppendAllText(log, "query-end-session\n");
            message.Result = new IntPtr(veto ? 0 : 1); return;
        }
        if (message.Msg == 0x0016 && message.WParam != IntPtr.Zero) {
            File.AppendAllText(log, "end-session\n");
            Dispose(); Application.ExitThread(); return;
        }
        base.WndProc(ref message);
    }
    [STAThread] public static void Main(string[] args) {
        Application.Run(new InfoBarTrayFixture(args[0], args.Length > 1 && args[1] == "veto"));
    }
}
