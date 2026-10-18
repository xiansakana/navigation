using System;
using System.IO;
using System.IO.Compression;
using System.Diagnostics;
using System.Drawing;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Collections.Generic;
using System.Windows.Forms;

// Generic bootstrapper: the server appends the public ZIP and a short-lived,
// one-use binding grant. No account credentials are compiled into this binary.
class WorkerInstaller : Form {
    TextBox log = new TextBox();
    Label status = new Label();
    ProgressBar progress = new ProgressBar();
    Button close = new Button();
    Process child;
    bool running;
    public WorkerInstaller() {
        Text = "Navigation 知识库工作器安装"; Width = 760; Height = 500;
        StartPosition = FormStartPosition.CenterScreen; MinimumSize = new Size(600, 380);
        status.Dock = DockStyle.Top; status.Height = 55; status.Padding = new Padding(12);
        status.Text = "正在准备安装，本程序会自动连接你的知识库账号。";
        progress.Dock = DockStyle.Top; progress.Height = 8; progress.Style = ProgressBarStyle.Marquee;
        log.Multiline = true; log.ReadOnly = true; log.ScrollBars = ScrollBars.Vertical; log.Dock = DockStyle.Fill;
        log.Font = new Font("Consolas", 10);
        close.Text = "关闭"; close.Dock = DockStyle.Bottom; close.Height = 38;
        close.Click += delegate { Close(); };
        Controls.Add(log); Controls.Add(progress); Controls.Add(status); Controls.Add(close);
        Shown += delegate { BeginInstall(); };
        FormClosing += delegate(object sender, FormClosingEventArgs e) {
            if (!running) return;
            if (MessageBox.Show("安装仍在进行。要停止安装吗？之后可以重新运行继续。", Text, MessageBoxButtons.YesNo) != DialogResult.Yes) { e.Cancel = true; return; }
            try {
                ProcessStartInfo kill = new ProcessStartInfo("taskkill.exe", "/PID " + child.Id + " /T /F");
                kill.UseShellExecute = false; kill.CreateNoWindow = true;
                using (Process p = Process.Start(kill)) { p.WaitForExit(5000); }
            } catch { }
        };
    }
    static string Extract() {
        string exe = Assembly.GetExecutingAssembly().Location;
        byte[] zip, metadata;
        using (FileStream f = File.OpenRead(exe)) {
            if (f.Length < 20) throw new Exception("安装包不完整，请从知识库重新下载。");
            f.Seek(-16, SeekOrigin.End);
            using (BinaryReader reader = new BinaryReader(f, Encoding.UTF8)) {
                int zipLength = reader.ReadInt32(), metaLength = reader.ReadInt32();
                string magic = Encoding.ASCII.GetString(reader.ReadBytes(8));
                if (magic != "NKWEXE01" || zipLength < 1 || zipLength > 2000000 || metaLength < 1 || metaLength > 4096 || zipLength + metaLength + 16 > f.Length)
                    throw new Exception("安装包校验失败，请从知识库重新下载。");
                f.Seek(-(zipLength + metaLength + 16), SeekOrigin.End);
                zip = reader.ReadBytes(zipLength); metadata = reader.ReadBytes(metaLength);
            }
        }
        JavaScriptSerializer json = new JavaScriptSerializer();
        Dictionary<string, object> meta = json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(metadata));
        string expected = (string)meta["sha256"];
        using (SHA256 hash = SHA256.Create()) {
            string actual = BitConverter.ToString(hash.ComputeHash(zip)).Replace("-", "").ToLowerInvariant();
            if (actual != expected) throw new Exception("安装文件完整性校验失败。");
        }
        string stage = Path.Combine(Path.GetTempPath(), "NavigationKnowledgeInstall", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(stage);
        using (MemoryStream stream = new MemoryStream(zip))
        using (ZipArchive archive = new ZipArchive(stream, ZipArchiveMode.Read)) {
            foreach (ZipArchiveEntry entry in archive.Entries) {
                string target = Path.GetFullPath(Path.Combine(stage, entry.FullName));
                if (!target.StartsWith(stage + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || entry.Length > 2000000) throw new Exception("安装文件路径无效。");
                Directory.CreateDirectory(Path.GetDirectoryName(target)); entry.ExtractToFile(target);
            }
        }
        if (meta.ContainsKey("binding") && meta["binding"] != null) File.WriteAllText(Path.Combine(stage, "worker-pairing.json"), json.Serialize(meta["binding"]), new UTF8Encoding(false));
        if (!File.Exists(Path.Combine(stage, "scripts", "setup-knowledge-worker.ps1"))) throw new Exception("缺少安装程序。");
        return stage;
    }
    void Append(string text) {
        if (text == null || IsDisposed || Disposing) return;
        try { BeginInvoke((Action)delegate { if (!IsDisposed) log.AppendText(Regex.Replace(text, "nkw_[a-f0-9]+", "[hidden]") + Environment.NewLine); }); } catch { }
    }
    void BeginInstall() {
        try {
            string stage = Extract();
            string shell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe");
            ProcessStartInfo start = new ProcessStartInfo(shell, "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(stage, "scripts", "setup-knowledge-worker.ps1") + "\"");
            start.WorkingDirectory = stage; start.UseShellExecute = false; start.CreateNoWindow = true;
            start.RedirectStandardOutput = true; start.RedirectStandardError = true;
            child = new Process(); child.StartInfo = start; child.EnableRaisingEvents = true;
            child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { Append(e.Data); };
            child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { Append(e.Data); };
            child.Exited += delegate {
                int code = child.ExitCode;
                BeginInvoke((Action)delegate {
                    running = false; progress.Style = ProgressBarStyle.Blocks; progress.Value = code == 0 ? 100 : 0;
                    status.Text = code == 0 ? "安装完成，已连接知识库。以后登录 Windows 时会自动启动。" : "安装尚未完成，请查看下方信息；修复后可重新运行此程序。";
                });
            };
            running = true; child.Start(); child.BeginOutputReadLine(); child.BeginErrorReadLine();
            status.Text = "正在安装依赖并绑定设备。首次需要联网，Codex 未登录时请完成浏览器登录。";
        } catch (Exception error) { running = false; progress.Style = ProgressBarStyle.Blocks; status.Text = "安装未完成"; Append(error.Message); }
    }
    [STAThread]
    static int Main(string[] args) {
        // Smoke-test the actual PE, overlay parser and extraction without changing
        // the user's worker, credentials or scheduled task.
        if (args.Length == 2 && args[0] == "--verify-only") {
            try { string stage = Extract(); File.WriteAllText(args[1], "EXE_BOOTSTRAP_OK\n" + stage, new UTF8Encoding(false)); return 0; }
            catch { return 1; }
        }
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new WorkerInstaller()); return 0;
    }
}
