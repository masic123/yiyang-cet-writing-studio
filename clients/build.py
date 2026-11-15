from pathlib import Path
import hashlib,json,os,re,secrets,shutil,subprocess,zipfile
from datetime import datetime,timezone,timedelta
SOURCE=Path(__file__).resolve().parent
ROOT=Path(os.environ.get('YIYANG_APP_BUILD_ROOT',str(SOURCE)))
import sys
sys.path.insert(0,str(ROOT/'tools/python'))
from PIL import Image
TOOLS=ROOT/'tools';DIST=ROOT/'dist';DIST.mkdir(exist_ok=True)
config=json.loads((ROOT/'release-config.json').read_text(encoding='utf-8'))
VERSION=config['version'];VERSION_CODE=config['androidVersionCode']
assert re.fullmatch(r'(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})',VERSION) and all(int(x)<=65535 for x in VERSION.split('.'))
assert isinstance(VERSION_CODE,int) and 1<=VERSION_CODE<=2100000000
manifest=(ROOT/'android/AndroidManifest.xml').read_text(encoding='utf-8')
manifest=re.sub(r'android:versionCode="\d+"',f'android:versionCode="{VERSION_CODE}"',manifest)
manifest=re.sub(r'android:versionName="[^"]+"',f'android:versionName="{VERSION}"',manifest)
(ROOT/'android/AndroidManifest.xml').write_text(manifest,encoding='utf-8')
(ROOT/'android/src/xyz/yiyangcet/app/BuildInfo.java').write_text(f'package xyz.yiyangcet.app;\nfinal class BuildInfo {{ static final String VERSION="{VERSION}"; static final int VERSION_CODE={VERSION_CODE}; }}\n',encoding='utf-8')
(ROOT/'windows/BuildInfo.cs').write_text(f'internal static class BuildInfo {{ public const string Version="{VERSION}";public const string AssemblyVersion="{VERSION}.0"; }}\n',encoding='utf-8')
JAVA=next((TOOLS/'jdk').glob('*/bin'))
BUILD=next((TOOLS/'build-tools').iterdir())
JAR=next((TOOLS/'platform').glob('*/android.jar'))
env=dict(os.environ,JAVA_HOME=str(JAVA.parent),PATH=str(JAVA)+os.pathsep+os.environ['PATH'])
def run(args):
    p=subprocess.run([str(x) for x in args],env=env,cwd=ROOT,text=True,encoding='utf-8',errors='replace',capture_output=True)
    if p.returncode:raise RuntimeError(p.stdout+'\n'+p.stderr)
    if p.stdout.strip():print(p.stdout.strip(),flush=True)
    if p.stderr.strip():print(p.stderr.strip(),flush=True)
    return p.stdout
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
icon=Image.open(SOURCE.parent/'public/apple-touch-icon-v20261029.png').convert('RGBA')
(ROOT/'android/res/drawable').mkdir(parents=True,exist_ok=True)
icon.resize((192,192),Image.Resampling.LANCZOS).save(ROOT/'android/res/drawable/app_icon.png')
icon.resize((256,256),Image.Resampling.LANCZOS).save(ROOT/'windows/app.ico',sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])
# Keep the release key separate from all distributable directories. It is required for future upgrades.
private=ROOT/'private';private.mkdir(exist_ok=True)
key=private/'yiyang-android-release.p12';secret=private/'keystore-password.txt'
assert secret.is_file() and key.is_file(),'Restore the existing release key; never generate a replacement for an app update'
android=ROOT/'android';work=ROOT/'android/build';work.mkdir(exist_ok=True)
classes=work/'classes';classes.mkdir(exist_ok=True)
for stale in classes.rglob('*.class'):
    assert stale.resolve().is_relative_to((SOURCE/'android/build/classes').resolve());stale.unlink()
run([BUILD/'aapt2.exe','compile','--dir',android/'res','-o',work/'resources.zip'])
run([BUILD/'aapt2.exe','link','-o',work/'unsigned.apk','-I',JAR,'--manifest',android/'AndroidManifest.xml','--java',work/'generated',work/'resources.zip'])
run([JAVA/'javac.exe','-encoding','UTF-8','-source','8','-target','8','-classpath',JAR,'-d',classes,*android.glob('src/**/*.java')])
run([BUILD/'d8.bat','--release','--min-api','26','--lib',JAR,'--output',work,*classes.rglob('*.class')])
with zipfile.ZipFile(work/'unsigned.apk','a',compression=zipfile.ZIP_DEFLATED) as z:z.write(work/'classes.dex','classes.dex')
run([BUILD/'zipalign.exe','-f','-p','4',work/'unsigned.apk',work/'aligned.apk'])
apk=DIST/f'yiyang-{VERSION}-android.apk'
run([BUILD/'apksigner.bat','sign','--ks',key,'--ks-key-alias','yiyang','--ks-pass','file:'+str(secret),'--out',apk,work/'aligned.apk'])
verified=run([BUILD/'apksigner.bat','verify','--verbose','--print-certs',apk])
assert 'Signer #1 certificate SHA-256 digest: '+config['androidCertificateSha256'] in verified,'Android signing certificate changed'
run([BUILD/'aapt2.exe','dump','badging',apk])
run([BUILD/'zipalign.exe','-c','-p','4',apk])
if '--android-only' in sys.argv:
    data=json.loads((DIST/'manifest.json').read_text(encoding='utf-8'))
    data['android'].update(file=apk.name,version=VERSION,versionCode=VERSION_CODE,bytes=apk.stat().st_size,sha256=sha(apk))
    (DIST/'manifest.json').write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(data,ensure_ascii=False,indent=2));sys.exit(0)
out=ROOT/'windows/bin';out.mkdir(exist_ok=True)
lib=TOOLS/'webview2/lib/net462';loader=TOOLS/'webview2/runtimes/win-x64/native/WebView2Loader.dll'
for file in [lib/'Microsoft.Web.WebView2.Core.dll',lib/'Microsoft.Web.WebView2.WinForms.dll',loader,ROOT/'windows/Yiyang.exe.config']:
    shutil.copy2(file,out/file.name)
run([Path('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe'),'/nologo','/target:winexe','/platform:x64','/optimize+','/utf8output','/out:'+str(out/'Yiyang.exe'),'/win32manifest:'+str(ROOT/'windows/app.manifest'),'/win32icon:'+str(ROOT/'windows/app.ico'),'/resource:'+str(ROOT/'windows/app.ico')+',app.ico','/reference:System.dll','/reference:System.Core.dll','/reference:System.Drawing.dll','/reference:System.Windows.Forms.dll','/reference:System.Net.Http.dll','/reference:System.Web.Extensions.dll','/reference:'+str(lib/'Microsoft.Web.WebView2.Core.dll'),'/reference:'+str(lib/'Microsoft.Web.WebView2.WinForms.dll'),*ROOT.glob('windows/*.cs')])
shutil.copy2(ROOT/'windows/app.ico',out/'app.ico')
shutil.copy2(TOOLS/'webview2/LICENSE.txt',out/'WebView2-LICENSE.txt')
shutil.copy2(TOOLS/'webview2/NOTICE.txt',out/'WebView2-ThirdPartyNotices.txt')
run([TOOLS/'nsis/nsis-3.13/makensis.exe','/INPUTCHARSET','UTF8','/V2','/DAPP_VERSION='+VERSION,ROOT/'windows/installer.nsi'])
data={'version':VERSION,'publishedAt':datetime.now(timezone(timedelta(hours=8))).date().isoformat(),'site':'https://yiyangcet.xyz','releaseNotes':config['releaseNotes'],'nativeUpdateVersion':'1.0.2','android':{'versionCode':VERSION_CODE,'file':apk.name,'bytes':apk.stat().st_size,'sha256':sha(apk),'minimum':'Android 8.0'},'windows':{'file':f'yiyang-{VERSION}-windows-x64-setup.exe','minimum':'Windows 10 / 11（64 位）'}}
exe=DIST/data['windows']['file'];data['windows'].update(bytes=exe.stat().st_size,sha256=sha(exe))
data['android']['version']=VERSION;data['windows']['version']=VERSION
(DIST/'manifest.json').write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(data,ensure_ascii=False,indent=2),flush=True)
