using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Net.Http;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: AssemblyTitle("译洋")]
[assembly: AssemblyDescription("译洋 · 四六级写作与翻译")]
[assembly: AssemblyCompany("译洋")]
[assembly: AssemblyProduct("译洋")]
[assembly: AssemblyVersion(BuildInfo.AssemblyVersion)]
[assembly: AssemblyFileVersion(BuildInfo.AssemblyVersion)]
[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.7.2")]

internal static class Program {
    [STAThread] static void Main() {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new MainWindow());
    }
}
internal sealed class MainWindow : Form {
    private const string Home="https://yiyangcet.xyz/";
    private readonly WebView2 view=new WebView2();
    private readonly Label status=new Label();
    private readonly Button retry=new Button();
    private readonly Panel problem=new Panel();
    private readonly System.Windows.Forms.Timer updateTimer=new System.Windows.Forms.Timer{Interval=300000};
    private bool checkingUpdate;
    private bool initialized;
    private DateTime lastUpdateCheck=DateTime.MinValue;
    private string lastPromptedVersion;
    private DateTime lastPromptedAt=DateTime.MinValue;
    private readonly string updatePreferences=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Yiyang","update-reminder.txt");
    private readonly string profile=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Yiyang","WebView2");
    public MainWindow(){
        Text="译洋 · 四六级写作与翻译";ClientSize=new Size(1280,820);MinimumSize=new Size(880,600);StartPosition=FormStartPosition.CenterScreen;
        AutoScaleMode=AutoScaleMode.Dpi; BackColor=Color.FromArgb(245,247,250);
        using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("app.ico")){if(stream!=null)Icon=new Icon(stream);}
        var menu=new MenuStrip();menu.BackColor=BackColor;
        menu.Items.Add("后退",null,delegate{if(view.CoreWebView2!=null && view.CanGoBack)view.GoBack();});
        menu.Items.Add("刷新",null,delegate{if(view.CoreWebView2!=null)view.Reload();});
        menu.Items.Add("在浏览器打开",null,delegate{OpenExternal(Home);});
        menu.Items.Add("检查更新",null,async delegate{await CheckUpdates(true);});
        menu.Items.Add("关于译洋",null,delegate{MessageBox.Show(this,"译洋 "+BuildInfo.Version+"\n四六级写作与翻译\n\n在线客户端，需要联网使用。\n登录状态保存在本机，网页与客户端分别登录。\n官方网站：yiyangcet.xyz\n官方 QQ 群：1059633594","关于译洋",MessageBoxButtons.OK,MessageBoxIcon.Information);});
        MainMenuStrip=menu;view.Dock=DockStyle.Fill;Controls.Add(view);Controls.Add(menu);
        problem.Dock=DockStyle.Fill;problem.BackColor=BackColor;
        status.Text="正在连接译洋…";status.AutoSize=true;status.Font=new Font("Microsoft YaHei UI",14);status.ForeColor=Color.FromArgb(23,43,77);status.Location=new Point(40,50);
        retry.Text="重新连接";retry.Location=new Point(44,110);retry.Size=new Size(120,38);retry.Visible=false;retry.Click+=delegate{problem.Visible=false;view.CoreWebView2.Navigate(Home);};
        problem.Controls.Add(status);problem.Controls.Add(retry);Controls.Add(problem);problem.BringToFront();menu.BringToFront();
        Shown+=async delegate{await Initialize();initialized=true;updateTimer.Start();await CheckUpdates(false);};
        Activated+=async delegate{if(initialized)await CheckUpdates(false);};
        updateTimer.Tick+=async delegate{await CheckUpdates(false);};
    }
    private static bool IsInternal(string address){Uri uri;return Uri.TryCreate(address,UriKind.Absolute,out uri)&&uri.Scheme=="https"&&uri.Host=="yiyangcet.xyz"&&uri.IsDefaultPort;}
    private void OpenExternal(string address){
        Uri uri;if(!Uri.TryCreate(address,UriKind.Absolute,out uri)||!(uri.Scheme=="https"||uri.Scheme=="mailto"))return;
        try{Process.Start(new ProcessStartInfo(address){UseShellExecute=true});}catch{MessageBox.Show(this,"无法打开浏览器，请访问 yiyangcet.xyz。","译洋");}
    }
    private async System.Threading.Tasks.Task Initialize(){
        try{
            var environment=await CoreWebView2Environment.CreateAsync(null,profile,null);
            await view.EnsureCoreWebView2Async(environment);
            var core=view.CoreWebView2;
            core.Settings.IsStatusBarEnabled=false;core.Settings.AreDevToolsEnabled=false;core.Settings.AreHostObjectsAllowed=false;core.Settings.IsWebMessageEnabled=false;
            core.Settings.UserAgent=core.Settings.UserAgent+" YiyangWindows/"+BuildInfo.Version;
            core.NavigationStarting+=(sender,e)=>{if(!IsInternal(e.Uri)){e.Cancel=true;OpenExternal(e.Uri);}else{retry.Visible=false;}};
            core.NewWindowRequested+=(sender,e)=>{e.Handled=true;if(!e.IsUserInitiated)return;if(IsInternal(e.Uri))core.Navigate(e.Uri);else OpenExternal(e.Uri);};
            core.NavigationCompleted+=(sender,e)=>{problem.Visible=!e.IsSuccess;if(!e.IsSuccess){status.Text="暂时无法连接译洋，请检查网络后重试。";retry.Visible=true;problem.BringToFront();}};
            core.ProcessFailed+=(sender,e)=>{status.Text="页面暂时中断，请重新连接。";retry.Visible=true;problem.Visible=true;problem.BringToFront();};
            core.PermissionRequested+=(sender,e)=>{e.State=CoreWebView2PermissionState.Deny;};
            core.Navigate(Home);
        }catch(WebView2RuntimeNotFoundException){
            status.Text="此电脑需要 Microsoft Edge WebView2 运行时。";
            var install=new Button{Text="安装 WebView2",Location=new Point(44,110),Size=new Size(150,38)};
            install.Click+=delegate{OpenExternal("https://developer.microsoft.com/microsoft-edge/webview2/");};problem.Controls.Add(install);
        }catch(Exception){status.Text="译洋暂时无法启动，请重试或使用浏览器。";}
    }
    private async Task CheckUpdates(bool manual){
        if(checkingUpdate || IsDisposed || (!manual && (!Visible || WindowState==FormWindowState.Minimized || DateTime.UtcNow-lastUpdateCheck<TimeSpan.FromMinutes(5))))return;
        checkingUpdate=true;lastUpdateCheck=DateTime.UtcNow;
        try{
            string json=await Task.Run(async delegate{
                using(var client=new HttpClient{Timeout=TimeSpan.FromSeconds(12)}){
                    client.DefaultRequestHeaders.TryAddWithoutValidation("Cache-Control","no-cache");
                    client.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent","YiyangWindows/"+BuildInfo.Version);
                    using(var response=await client.GetAsync(Home+"downloads/manifest.json",HttpCompletionOption.ResponseHeadersRead)){
                        response.EnsureSuccessStatusCode();if(response.Content.Headers.ContentLength>65536)throw new IOException();
                        var content=await response.Content.ReadAsStringAsync();if(content.Length>65536)throw new IOException();
                        return content;
                    }
                }
            });
            if(IsDisposed || Disposing)return;
            if(ClientUpdate.Parse(json,"0.0.0")==null)throw new IOException();
            var update=ClientUpdate.Parse(json,BuildInfo.Version);
            if(update==null){if(manual)MessageBox.Show(this,"当前已是最新版本 v"+BuildInfo.Version,"检查更新",MessageBoxButtons.OK,MessageBoxIcon.Information);return;}
            if(!manual && !ContainsFocus){lastUpdateCheck=DateTime.MinValue;return;}
            if(!manual && ((update.Version==lastPromptedVersion && DateTime.UtcNow-lastPromptedAt<TimeSpan.FromHours(24)) || Deferred(update.Version)))return;
            lastPromptedVersion=update.Version;lastPromptedAt=DateTime.UtcNow;
            var choice=MessageBox.Show(this,"发现新版本 v"+update.Version+"（当前 v"+BuildInfo.Version+"）。\n\n现在下载更新吗？安装前请先保存练习并关闭客户端。\n选择“否”将在 24 小时后再次提醒。","译洋有新版本",MessageBoxButtons.YesNo,MessageBoxIcon.Information,MessageBoxDefaultButton.Button2);
            if(choice==DialogResult.Yes)OpenExternal(Home+"downloads/"+update.FileName);
            else try{Directory.CreateDirectory(Path.GetDirectoryName(updatePreferences));File.WriteAllLines(updatePreferences,new[]{update.Version,DateTime.UtcNow.Ticks.ToString()});}catch{}
        }catch{if(manual && !IsDisposed)MessageBox.Show(this,"暂时无法检查更新，请稍后重试。","检查更新",MessageBoxButtons.OK,MessageBoxIcon.Information);}
        finally{checkingUpdate=false;}
    }
    private bool Deferred(string version){
        try{var lines=File.ReadAllLines(updatePreferences);long ticks;return lines.Length==2 && lines[0]==version && long.TryParse(lines[1],out ticks) && ticks<=DateTime.UtcNow.Ticks && DateTime.UtcNow.Ticks-ticks<TimeSpan.FromHours(24).Ticks;}catch{return false;}
    }
    protected override bool ProcessCmdKey(ref Message msg,Keys key){
        if(key==Keys.F5 || key==(Keys.Control|Keys.R)){if(view.CoreWebView2!=null)view.Reload();return true;}
        if(key==(Keys.Alt|Keys.Left)){if(view.CoreWebView2!=null && view.CanGoBack)view.GoBack();return true;}
        return base.ProcessCmdKey(ref msg,key);
    }
    protected override void OnFormClosed(FormClosedEventArgs e){updateTimer.Stop();updateTimer.Dispose();view.Dispose();base.OnFormClosed(e);}
}
