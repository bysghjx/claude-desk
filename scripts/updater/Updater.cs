using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: AssemblyTitle("Claude Desk Updater")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

internal static class Updater {
    const string ManifestName="claude-desk-update.json", VersionName="claude-desk-version.json";
    static readonly UTF8Encoding Utf8=new UTF8Encoding(false);
    static readonly JavaScriptSerializer Json=new JavaScriptSerializer { MaxJsonLength=4*1024*1024 };
    static string stage, target, exe, from, to;
    static int retries=10000;
    static bool ownsStage;
    sealed class Entry { public string Rel, Source, Destination, Backup, Hash; public bool Existed, Remove; }
    static Dictionary<string,object> ObjectOf(object value) { var result=value as Dictionary<string,object>; if(result==null)throw new Exception("Invalid update metadata");return result; }
    static string Text(Dictionary<string,object> value,string key) { object found;return value.TryGetValue(key,out found)?found as string:null; }
    static void Write(string file,string text) { File.WriteAllText(file,text,Utf8); }
    static void Log(string text) { Write(Path.Combine(stage,"install.log"),text); }
    static string Hash(string file) { using(var stream=File.OpenRead(file))using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant(); }
    static string Root(string value) { var full=Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar);if(full==Path.GetPathRoot(full).TrimEnd(Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar))throw new Exception("Installation cannot be a drive root");return full; }
    static bool Under(string root,string file) { return file.StartsWith(root+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase); }
    static void NoLinks(string root,string file) {
        for(var path=file;;path=Path.GetDirectoryName(path)) {
            if((File.Exists(path)||Directory.Exists(path))&&(File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0)throw new Exception("Linked update path: "+path);
            if(String.Equals(path,root,StringComparison.OrdinalIgnoreCase))break;
            if(String.IsNullOrEmpty(path)||!Under(root,path))throw new Exception("Path outside update directory");
        }
    }
    static string Safe(string root,string relative) {
        if(String.IsNullOrEmpty(relative)||relative.Length>2000||relative.IndexOf('\\')>=0||relative.IndexOf(':')>=0||relative.StartsWith("/"))throw new Exception("Unsafe update path: "+relative);
        foreach(var part in relative.Split('/'))if(String.IsNullOrEmpty(part)||part=="."||part==".."||part.EndsWith(".")||part.EndsWith(" ")||part.IndexOfAny(Path.GetInvalidFileNameChars())>=0||Regex.IsMatch(part,@"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)",RegexOptions.IgnoreCase))throw new Exception("Unsafe update path: "+relative);
        var file=Path.GetFullPath(Path.Combine(root,relative.Replace('/',Path.DirectorySeparatorChar)));
        if(!Under(root,file))throw new Exception("Path outside update directory");NoLinks(root,file);return file;
    }
    static void Retry(Action action) {
        var timer=Stopwatch.StartNew();while(true)try{action();return;}catch(IOException){if(timer.ElapsedMilliseconds>=retries)throw;Thread.Sleep(100);}catch(UnauthorizedAccessException){if(timer.ElapsedMilliseconds>=retries)throw;Thread.Sleep(100);}
    }
    // Match the client's release ordering, including beta.2 < beta.10 < rc.1 < stable.
    static int Numeric(string a,string b) { return a.Length!=b.Length?a.Length.CompareTo(b.Length):String.CompareOrdinal(a,b); }
    static string[] ReleaseVersion(string value) {
        const string n="(?:0|[1-9][0-9]*)",id="(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
        if(value==null||!Regex.IsMatch(value,"^"+n+"[.]"+n+"[.]"+n+"(?:-"+id+"(?:[.]"+id+")*)?\\z"))throw new Exception("Invalid update version");
        return value.Split(new[]{'-'},2);
    }
    static int CompareVersions(string a,string b) {
        var av=ReleaseVersion(a);var bv=ReleaseVersion(b);var ac=av[0].Split('.');var bc=bv[0].Split('.');
        for(int i=0;i<3;i++){int c=Numeric(ac[i],bc[i]);if(c!=0)return c;}
        if(av.Length==1||bv.Length==1)return av.Length==bv.Length?0:av.Length==1?1:-1;
        var ap=av[1].Split('.');var bp=bv[1].Split('.');
        for(int i=0;i<Math.Max(ap.Length,bp.Length);i++){
            if(i>=ap.Length||i>=bp.Length)return i>=ap.Length?-1:1;
            if(ap[i]==bp[i])continue;
            bool an=Regex.IsMatch(ap[i],"^[0-9]+$"),bn=Regex.IsMatch(bp[i],"^[0-9]+$");
            return an&&bn?Numeric(ap[i],bp[i]):an!=bn?(an?-1:1):String.CompareOrdinal(ap[i],bp[i]);
        }
        return 0;
    }
    static string InstalledVersion() {
        var marker=Safe(target,VersionName);
        if(File.Exists(marker)){var data=ObjectOf(Json.DeserializeObject(File.ReadAllText(marker,Utf8)));if(Text(data,"app")!="ClaudeDesk")throw new Exception("Invalid installation marker");return Text(data,"version");}
        // Bootstrap from releases before the external version marker existed.
        using(var stream=File.OpenRead(Safe(target,"resources/app.asar")))using(var reader=new BinaryReader(stream,Utf8)) {
            if(reader.ReadUInt32()!=4)throw new Exception("Cannot read installed ASAR version");
            var length=reader.ReadInt32();if(length<8||length>4*1024*1024)throw new Exception("Invalid ASAR header");
            var header=reader.ReadBytes(length);if(header.Length!=length)throw new Exception("Truncated ASAR header");var textLength=BitConverter.ToInt32(header,4);if(textLength<0||textLength>length-8)throw new Exception("Invalid ASAR metadata");
            var files=ObjectOf(ObjectOf(Json.DeserializeObject(Utf8.GetString(header,8,textLength)))["files"]);
            var package=ObjectOf(files["package.json"]);var size=Convert.ToInt32(package["size"],CultureInfo.InvariantCulture);var offset=Convert.ToInt64(package["offset"],CultureInfo.InvariantCulture);
            if(size<0||size>1024*1024||offset<0||8L+length+offset+size>stream.Length)throw new Exception("Invalid ASAR package entry");
            stream.Position=8L+length+offset;return Text(ObjectOf(Json.DeserializeObject(Utf8.GetString(reader.ReadBytes(size)))),"version");
        }
    }
    static List<Entry> Plan() {
        var info=ObjectOf(Json.DeserializeObject(File.ReadAllText(Path.Combine(stage,ManifestName),Utf8)));
        if(Text(info,"app")!="ClaudeDesk"||Text(info,"from")!=from||String.IsNullOrEmpty(Text(info,"to")))throw new Exception("Update package/version mismatch");
        to=Text(info,"to");if(CompareVersions(to,from)<=0)throw new Exception("Update version must be newer");
        var entries=new List<Entry>();var names=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var reserved=new HashSet<string>(new[]{".runner","backup","backup-index.json","install.log","install.lock","install-result.json","runner.ready",".claude-desk-update.lock"},StringComparer.OrdinalIgnoreCase);
        foreach(var pair in ObjectOf(info["files"])) {
            if(reserved.Contains(pair.Key.Split('/')[0]))throw new Exception("Reserved updater path: "+pair.Key);
            var hash=pair.Value as string;if(hash==null||!Regex.IsMatch(hash,"^[0-9a-f]{64}$"))throw new Exception("Invalid file hash: "+pair.Key);
            if(!names.Add(pair.Key))throw new Exception("Duplicate update path");
            entries.Add(new Entry { Rel=pair.Key,Source=Safe(stage,pair.Key),Destination=Safe(target,pair.Key),Hash=hash });
        }
        object removed;if(info.TryGetValue("removed",out removed))foreach(var value in (IEnumerable)removed) {
            var rel=value as string;if(rel==null||reserved.Contains(rel.Split('/')[0])||String.Equals(rel,"ClaudeDesk.exe",StringComparison.OrdinalIgnoreCase))throw new Exception("Invalid removal path");if(!names.Add(rel))throw new Exception("Conflicting update path");entries.Add(new Entry { Rel=rel,Destination=Safe(target,rel),Remove=true });
        }
        foreach(var entry in entries)if(!entry.Remove&&(!File.Exists(entry.Source)||Hash(entry.Source)!=entry.Hash))throw new Exception("Update file damaged or missing: "+entry.Rel);
        return entries;
    }
    static void Install(Entry entry) {
        NoLinks(target,entry.Destination);
        if(entry.Remove){if(File.Exists(entry.Destination))Retry(()=>File.Delete(entry.Destination));return;}
        Directory.CreateDirectory(Path.GetDirectoryName(entry.Destination));
        // A sibling temporary file makes each replacement atomic on the same volume.
        var temporary=entry.Destination+".desk-update-"+Guid.NewGuid().ToString("N");
        try {
            File.Copy(entry.Source,temporary,false);if(Hash(temporary)!=entry.Hash)throw new Exception("Update changed after verification: "+entry.Rel);
            Retry(()=>{NoLinks(target,entry.Destination);if(File.Exists(entry.Destination))File.Replace(temporary,entry.Destination,null,true);else File.Move(temporary,entry.Destination);});
        }finally{if(File.Exists(temporary))File.Delete(temporary);}
    }
    static void Restore(Entry entry) {
        NoLinks(target,entry.Destination);
        if(entry.Existed){Directory.CreateDirectory(Path.GetDirectoryName(entry.Destination));Retry(()=>File.Copy(entry.Backup,entry.Destination,true));}
        else if(File.Exists(entry.Destination))Retry(()=>File.Delete(entry.Destination));
    }
    static Process Parent(int pid,string expected) {
        if(pid==0)return null;
        try {var process=Process.GetProcessById(pid);if(process.HasExited){process.Dispose();return null;}if(!String.Equals(Path.GetFullPath(process.MainModule.FileName),Path.GetFullPath(expected),StringComparison.OrdinalIgnoreCase)){process.Dispose();throw new Exception("Waiting process does not match Claude Desk");}var handle=process.Handle;return process;}
        catch(ArgumentException){return null;}
    }
    static bool Run(Dictionary<string,string> options) {
        stage=Root(options["--stage"]);target=Root(options["--target"]);exe=Path.GetFullPath(options["--exe"]);from=options["--from"];
        if(stage==target||Under(stage,target)||Under(target,stage)||!String.Equals(exe,Path.Combine(target,"ClaudeDesk.exe"),StringComparison.OrdinalIgnoreCase))throw new Exception("Invalid installation directories");
        NoLinks(stage,stage);NoLinks(target,target);
        int pid=Int32.Parse(options["--wait-pid"],CultureInfo.InvariantCulture),wait=120000;string setting;
        if(options.TryGetValue("--retry-ms",out setting))retries=Math.Max(0,Math.Min(30000,Int32.Parse(setting,CultureInfo.InvariantCulture)));
        if(options.TryGetValue("--wait-ms",out setting))wait=Math.Max(1,Math.Min(120000,Int32.Parse(setting,CultureInfo.InvariantCulture)));
        var expected=options.ContainsKey("--wait-exe")?options["--wait-exe"]:exe;
        var changed=new List<Entry>();bool committed=false,rollbackComplete=true,parentExited=pid==0;
        using(var active=File.Open(Path.Combine(stage,"install.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None))
        using(var installLock=File.Open(Safe(target,".claude-desk-update.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None))
        using(var parent=Parent(pid,expected)) {
            ownsStage=true;
            if(File.Exists(Path.Combine(stage,"backup-index.json")))throw new Exception("An earlier update needs recovery; its backup was retained");
            try {
                var entries=Plan();Log("waiting "+from+" -> "+to);Write(Path.Combine(stage,"runner.ready"),"ready");
                if(parent!=null&&!parent.WaitForExit(wait))throw new Exception("Claude Desk did not exit; no files were changed");
                parentExited=true;
                if(InstalledVersion()!=from)throw new Exception("Installed version changed; update cancelled");
                // Copy all old files before making any modifications.
                var backupRoot=Path.Combine(stage,"backup");Directory.CreateDirectory(backupRoot);
                var journal=new List<object>();
                foreach(var entry in entries) {
                    NoLinks(target,entry.Destination);if(Directory.Exists(entry.Destination))throw new Exception("Expected a file: "+entry.Rel);
                    entry.Existed=File.Exists(entry.Destination);entry.Backup=Safe(backupRoot,entry.Rel);
                    if(entry.Existed){Directory.CreateDirectory(Path.GetDirectoryName(entry.Backup));File.Copy(entry.Destination,entry.Backup,false);}
                    journal.Add(new { path=entry.Rel, existed=entry.Existed });
                }
                Write(Path.Combine(stage,"backup-index.json"),Json.Serialize(journal));Log("installing "+from+" -> "+to);
                foreach(var entry in entries){Install(entry);changed.Add(entry);}
                foreach(var entry in entries)if(entry.Remove?File.Exists(entry.Destination):!File.Exists(entry.Destination)||Hash(entry.Destination)!=entry.Hash)throw new Exception("Installed file verification failed: "+entry.Rel);
                if(InstalledVersion()!=to)throw new Exception("Installed version verification failed");
                committed=true;Write(Path.Combine(stage,"install-result.json"),Json.Serialize(new { status="ok",from=from,to=to }));Log("ok "+from+" -> "+to);
            }catch(Exception error) {
                var message=error.Message;
                for(int i=changed.Count-1;i>=0;i--)try{Restore(changed[i]);}catch(Exception restore){rollbackComplete=false;message+="; rollback: "+restore.Message;}
                Write(Path.Combine(stage,"install-result.json"),Json.Serialize(new { status="failed",rollbackComplete=rollbackComplete,error=message }));
                Log("failed: "+message+(rollbackComplete?" (old application retained/restored)":"; recovery backup: "+stage));
                if(!rollbackComplete)throw new Exception(message+"; recovery backup: "+stage);
            }
            if(parentExited&&!options.ContainsKey("--no-restart")&&(committed||rollbackComplete)&&File.Exists(exe))Process.Start(new ProcessStartInfo(exe) { WorkingDirectory=target,UseShellExecute=true });
        }
        return committed;
    }
    [STAThread] static int Main(string[] args) {
        if(args.Length==0){MessageBox.Show("请在 Claude Desk 的“关于与更新”中安装更新包。\n更新器会在主程序退出后自动完成替换和校验。","Claude Desk Updater",MessageBoxButtons.OK,MessageBoxIcon.Information);return 0;}
        try {
            var options=new Dictionary<string,string>();
            for(int i=0;i<args.Length;i++){if(args[i]=="--no-restart")options.Add(args[i],"true");else{if(i+1>=args.Length)throw new Exception("Missing updater argument");options.Add(args[i],args[++i]);}}
            return Run(options)?0:1;
        }catch(Exception error) {
            if(ownsStage&&stage!=null&&Directory.Exists(stage))try{Log("failed: "+error.Message);}catch{}
            return 1;
        }
    }
}
