using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

internal sealed class ClientUpdate {
    public string Version,FileName;
    public static ClientUpdate Parse(string json,string installed){
        if(json==null || json.Length>65536 || !Regex.IsMatch(installed,@"^\d{1,6}\.\d{1,6}\.\d{1,6}$"))return null;
        try{
            var serializer=new JavaScriptSerializer{MaxJsonLength=65536,RecursionLimit=8};
            var root=serializer.DeserializeObject(json) as Dictionary<string,object>;object raw;
            if(root==null || !root.TryGetValue("windows",out raw))return null;
            var row=raw as Dictionary<string,object>;object ver,file,hash,size;
            if(row==null || !row.TryGetValue("version",out ver) || !row.TryGetValue("file",out file) || !row.TryGetValue("sha256",out hash) || !row.TryGetValue("bytes",out size))return null;
            string version=ver as string,name=file as string,digest=hash as string;System.Version next,current;
            if(version==null || !Regex.IsMatch(version,@"^\d{1,6}\.\d{1,6}\.\d{1,6}$") || !System.Version.TryParse(version,out next) || !System.Version.TryParse(installed,out current) || next<=current)return null;
            if(name!="yiyang-"+version+"-windows-x64-setup.exe" || digest==null || !Regex.IsMatch(digest,"^[a-f0-9]{64}$"))return null;
            if(!(size is int) && !(size is long))return null;
            long bytes=Convert.ToInt64(size);if(bytes<=0 || bytes>100000000)return null;
            return new ClientUpdate{Version=version,FileName=name};
        }catch{return null;}
    }
}
