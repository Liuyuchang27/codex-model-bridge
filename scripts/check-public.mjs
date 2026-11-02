import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const files=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
if(!files.length)throw new Error('No tracked files. Stage the intended public source before auditing.');
const failures=[];
const patterns=[
  ['personal absolute path',/(?:\/Users\/|\/home\/|\/var\/folders\/|\/private\/var\/folders\/)[^\s"'`]+/],
  ['provider or GitHub secret',/\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['private key block',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['JWT-like credential',/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/],
  ['credential-bearing URL',/https?:\/\/[^\s/]+:[^\s/]+@/],
];
for(const file of files){
  if(/^(?:\.runtime|receipts|node_modules)\//.test(file)||/^evidence\/(?!README\.md$)/.test(file)||/(?:^|\/)(?:auth\.json|config\.json|config\.toml|\.env(?:\..*)?)$/.test(file)||/\.(?:png|jpe?g|webp|har|sqlite(?:-.*)?|db|log|pem|key|p12|pfx)$/i.test(file))failures.push({file,reason:'private/runtime artifact'});
  const path=resolve(root,file);
  if(lstatSync(path).isSymbolicLink()){failures.push({file,reason:'symlink requires manual review'});continue;}
  const bytes=execFileSync('git',['show',':'+file],{cwd:root,maxBuffer:8*1024*1024});
  if(bytes.includes(0)){failures.push({file,reason:'unexpected binary artifact'});continue;}
  const text=bytes.toString('utf8');
  for(const [reason,pattern]of patterns)if(pattern.test(text))failures.push({file,reason});
}
if(failures.length){console.error(JSON.stringify({passed:false,failures},null,2));process.exitCode=1;}
else console.log(JSON.stringify({passed:true,trackedFiles:files.length,scope:'exact staged snapshots; review Git history separately'}));
