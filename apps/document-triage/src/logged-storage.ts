import { createHash } from 'node:crypto';
import { constants, lstatSync, mkdirSync, openSync, readSync, readFileSync, readdirSync, realpathSync, fstatSync, fsyncSync, closeSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindDecision, decisionHash } from 'hiveagents-runtime/orchestration';
import type { DecisionBinding } from 'hiveagents-runtime/orchestration';
import type { RunIdentity, ManagedEffectAssociation } from 'hiveagents-runtime/orchestration/log';
import { validateDocuments } from './validation.js';
export const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export interface LoggedOptions { stateDirectory: string; runId: string; documents?: unknown }
export interface LoggedManifest {
 format: 1; identity: RunIdentity; documents: {id:string;text:string}[]; inputDigest: string; reportPath: string;
 payload: { documents: { id: string; category: string }[] }; payloadDigest: string;
 decisionId: string; binding: DecisionBinding; association: ManagedEffectAssociation;
}
export interface LoggedState { root: string; directory: string; databasePath: string; manifest: LoggedManifest }
export function privateDirectory(path: string, create = false): string {
 if(create) mkdirSync(path,{recursive:true,mode:0o700});
 const stat=lstatSync(path); if(!stat.isDirectory() || stat.isSymbolicLink() || stat.uid!==process.getuid?.() || (stat.mode & 0o077)!==0) throw Error('Private state directory is required');
 return realpathSync(path);
}
export function readPrivateFile(path: string, max = 2 * 1024 * 1024): string {
 if(typeof path!=='string' || !Number.isSafeInteger(max) || max<0 || max>2*1024*1024)throw Error('Invalid private read limit');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try {
  const stat=fstatSync(fd,{bigint:true});
  if(!stat.isFile() || stat.uid!==BigInt(process.getuid?.()??-1) || (stat.mode & 0o077n)!==0n || stat.size>BigInt(max) || stat.nlink!==1n)throw Error('Invalid private state file');
  // Allocate only the pinned initial size, never the subsequently observed whole file.
  const bytes=Buffer.alloc(Number(stat.size));let offset=0;
  while(offset<bytes.length){const count=readSync(fd,bytes,offset,Math.min(65536,bytes.length-offset),offset);if(count===0)throw Error('Private state file changed');offset+=count;}
  const probe=Buffer.alloc(1);if(readSync(fd,probe,0,1,offset)!==0)throw Error('Private state file changed');
  const after=fstatSync(fd,{bigint:true}),pathStat=lstatSync(path,{bigint:true});
  if(after.ino!==stat.ino || after.dev!==stat.dev || after.size!==stat.size || after.mtimeNs!==stat.mtimeNs || after.ctimeNs!==stat.ctimeNs
   || after.nlink!==stat.nlink || after.mode!==stat.mode || after.uid!==stat.uid || pathStat.ino!==stat.ino || pathStat.dev!==stat.dev
   || pathStat.size!==stat.size || pathStat.mtimeNs!==stat.mtimeNs || pathStat.ctimeNs!==stat.ctimeNs || pathStat.nlink!==stat.nlink || pathStat.mode!==stat.mode || pathStat.uid!==stat.uid || !pathStat.isFile())throw Error('Private state file changed');
  return bytes.toString('utf8');
 }finally{closeSync(fd);}
}
export function writeExclusive(path: string, bytes: string): void {
 privateDirectory(dirname(path)); const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try {writeFileSync(fd,bytes);fsyncSync(fd);} finally {closeSync(fd);}
 const directory=openSync(dirname(path),constants.O_RDONLY);try{fsyncSync(directory);}finally{closeSync(directory);}
}
function harnessDigest():string {
 const directory=dirname(fileURLToPath(import.meta.url));
 return sha(readdirSync(directory).filter(name=>/^logged-.*\.js$/.test(name)).sort().map(name=>`${name}:${sha(readFileSync(join(directory,name)))}`).join('\n'));
}
export function openLoggedState(options: LoggedOptions, create = false, execute = false): LoggedState {
 if(typeof options.runId!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(options.runId)) throw Error('Invalid logged run id');
 const root=privateDirectory(resolve(options.stateDirectory),create), runs=privateDirectory(join(root,'runs'),create);
 const directory=privateDirectory(join(runs,sha(options.runId)),create), reports=privateDirectory(join(root,'reports'),create), manifestPath=join(directory,'manifest.json');
 let raw:string;
 try {raw=readPrivateFile(manifestPath);}catch(error){
  if(!create || (error as NodeJS.ErrnoException).code!=='ENOENT') throw error;
  const documents=validateDocuments(options.documents).map(document=>({...document}));if(Buffer.byteLength(JSON.stringify(documents))>1024*1024)throw Error('Input exceeds logged app limit');
  const payload={documents:documents.map(document=>({id:document.id,category:/vpn|network|dns/i.test(document.text)?'network':/backup|restore/i.test(document.text)?'backups':'other'}))};
  const identity:RunIdentity={systemId:'document-triage',generation:1,runId:options.runId,agentId:'local-triage',harness:{id:'document-triage-local',version:'1',digest:harnessDigest()}};
  const reportPath=join(reports,`${sha(options.runId)}.json`), payloadDigest=decisionHash(payload);
  const binding=bindDecision({input:{documents,reportPath,payloadDigest},authority:{id:'local-report-owner'},inputVersion:'document-triage-log:1',authorityVersion:'1'});
  const manifest:LoggedManifest={format:1,identity,documents,inputDigest:decisionHash(documents),reportPath,payload,payloadDigest,decisionId:`report-${sha(options.runId)}`,binding,
   association:{identity,stepId:'report',effectKey:'owned-report',operation:{id:'write-report',version:'1',targetDigest:sha(reportPath),contentDigest:payloadDigest}}};
  const encoded=JSON.stringify(manifest);if(Buffer.byteLength(encoded)>2*1024*1024)throw Error('Logged manifest exceeds app limit');try{writeExclusive(manifestPath,encoded);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}raw=readPrivateFile(manifestPath);
 }
 const manifest=JSON.parse(raw) as LoggedManifest;
 if(manifest.format!==1 || manifest.identity?.runId!==options.runId || manifest.identity.systemId!=='document-triage' || manifest.identity.generation!==1 || manifest.identity.agentId!=='local-triage' || manifest.identity.harness?.id!=='document-triage-local' || manifest.identity.harness.version!=='1'
  || manifest.reportPath!==join(reports,`${sha(options.runId)}.json`) || manifest.decisionId!==`report-${sha(options.runId)}`
  || decisionHash(manifest.documents)!==manifest.inputDigest || decisionHash(manifest.payload)!==manifest.payloadDigest
  || JSON.stringify(manifest.association.identity)!==JSON.stringify(manifest.identity)
  || manifest.association.operation.targetDigest!==sha(manifest.reportPath) || manifest.association.operation.contentDigest!==manifest.payloadDigest) throw Error('Logged manifest binding changed');
 const expectedAssociation={identity:manifest.identity,stepId:'report',effectKey:'owned-report',operation:{id:'write-report',version:'1',targetDigest:sha(manifest.reportPath),contentDigest:manifest.payloadDigest}};
 if(JSON.stringify(manifest.association)!==JSON.stringify(expectedAssociation))throw Error('Logged effect recipe changed');
 const binding=bindDecision({input:{documents:manifest.documents,reportPath:manifest.reportPath,payloadDigest:manifest.payloadDigest},authority:{id:'local-report-owner'},inputVersion:'document-triage-log:1',authorityVersion:'1'});
 if(JSON.stringify(binding)!==JSON.stringify(manifest.binding) || options.documents!==undefined && decisionHash(validateDocuments(options.documents).map(document=>({...document})))!==manifest.inputDigest
  || execute && manifest.identity.harness.digest!==harnessDigest()) throw Error('Logged input or harness changed');
 return {root,directory,databasePath:join(directory,'execution.sqlite'),manifest};
}
