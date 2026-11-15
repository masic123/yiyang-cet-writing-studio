import {readFile,writeFile,copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const project=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const clients=path.resolve(process.env.CLIENT_SOURCE_DIRECTORY || path.join(project,'clients'));
function run(command,args,options={}) {
  const result=spawnSync(command,args,{cwd:project,stdio:'inherit',...options});
  if(result.error)throw result.error;
  if(result.status!==0)throw Error(`Build command failed: ${command} (${result.status})`);
}
function curl(url){
  const result=spawnSync('curl.exe',['--silent','--show-error','--fail','--retry','3','--retry-all-errors','--connect-timeout','10','--max-time','25','-H','Cache-Control: no-cache',url],{encoding:'utf8',maxBuffer:5*1024*1024});
  if(result.error || result.status!==0)throw Error('Could not verify the live release: '+(result.error?.message||result.stderr));
  return result.stdout;
}
function tuple(version){
  if(!/^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/.test(version))throw Error('Invalid version');
  const parts=version.split('.').map(Number);if(parts.some(value=>value>65535))throw Error('Version exceeds installer limits');return parts;
}
function compare(a,b){const left=tuple(a),right=tuple(b);for(let i=0;i<3;i++)if(left[i]!==right[i])return left[i]>right[i]?1:-1;return 0;}
const live=JSON.parse(curl('https://yiyangcet.xyz/downloads/manifest.json'));
const configPath=path.join(clients,'release-config.json');
const config=JSON.parse(await readFile(configPath,'utf8'));
const baseline=[live.android.version,live.windows.version].sort(compare).at(-1);
const requested=process.argv.includes('--version')?process.argv[process.argv.indexOf('--version')+1]:null;
const parts=tuple(baseline);if(parts[2]===65535){parts[1]++;parts[2]=0;}else parts[2]++;
const version=requested||parts.join('.');tuple(version);
if(compare(version,baseline)<=0)throw Error('Both installers must be newer than the live release');
if(config.version!==version)config.androidVersionCode=Math.max(config.androidVersionCode+1,(live.android.versionCode||0)+1);
else config.androidVersionCode=Math.max(config.androidVersionCode,(live.android.versionCode||0)+1);
config.version=version;
await writeFile(configPath,JSON.stringify(config,null,2)+'\n');
console.log(`Preparing synchronized Android and Windows release ${version}`);
const python=process.env.PYTHON_COMMAND || 'python';
run(python,[path.join(clients,'build.py')],{env:{...process.env,PYTHONIOENCODING:'utf-8',YIYANG_APP_BUILD_ROOT:process.env.YIYANG_APP_BUILD_ROOT || clients}});
const manifest=JSON.parse(await readFile(path.join(clients,'dist/manifest.json'),'utf8'));
const sha=data=>createHash('sha256').update(data).digest('hex');
for(const platform of ['android','windows']){
  const item=manifest[platform],bytes=await readFile(path.join(clients,'dist',item.file));
  if(item.version!==version || item.bytes!==bytes.length || item.sha256!==sha(bytes))throw Error('Installer release mismatch: '+platform);
  await copyFile(path.join(clients,'dist',item.file),path.join(project,'public/downloads',item.file));
}
await copyFile(path.join(clients,'dist/manifest.json'),path.join(project,'public/downloads/manifest.json'));
await copyFile(path.join(clients,'dist/manifest.json'),path.join(project,'src/lib/client-downloads.json'));
run(process.execPath,['node_modules/next/dist/bin/next','build','--webpack'],{env:{...process.env,CET_EXPORT_DIRECTORY:'.next-translation-session'}});
run(process.execPath,['scripts/build-vps.mjs'],{env:{...process.env,CET_RELEASE_DIRECTORY:'storage/translation-session-release'}});
const prepared={version,previous:{android:live.android.version,windows:live.windows.version},indexSha256:sha(await readFile(path.join(project,'.next-translation-session/index.html'))),serverSha256:sha(await readFile(path.join(project,'storage/translation-session-release/server.mjs'))),manifestSha256:sha(await readFile(path.join(project,'public/downloads/manifest.json'))),android:manifest.android,windows:manifest.windows};
await writeFile(path.join(project,'.client-release-prepared.json'),JSON.stringify(prepared,null,2)+'\n');
console.log(JSON.stringify({synchronizedReleasePrepared:true,version,android:manifest.android.file,windows:manifest.windows.file}));
