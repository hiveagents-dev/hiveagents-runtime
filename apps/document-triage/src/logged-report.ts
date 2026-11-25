import { lstatSync } from 'node:fs';
import { decisionHash } from 'hiveagents-runtime/orchestration';
import type { JsonValue } from 'hiveagents-runtime/orchestration';
import { readPrivateFile, sha, writeExclusive } from './logged-storage.js';
import type { LoggedManifest } from './logged-storage.js';
export interface ReportEvidence { kind:'applied'|'absent'|'mismatch'; digest?: string }
export function reportResult(manifest:LoggedManifest):JsonValue {return {reportPath:manifest.reportPath,payloadDigest:manifest.payloadDigest,documents:manifest.documents.length};}
export function verifyReport(manifest:LoggedManifest,intentId?:string):ReportEvidence {
 try {const raw=readPrivateFile(manifest.reportPath), value=JSON.parse(raw);
  if(!intentId || value.format!==1 || value.runId!==manifest.identity.runId || value.intentId!==intentId || value.payloadDigest!==manifest.payloadDigest || decisionHash(value.payload)!==manifest.payloadDigest
   || JSON.stringify(value.payload)!==JSON.stringify(manifest.payload))return {kind:'mismatch'};
  return {kind:'applied',digest:sha(raw)};
 }catch(error){return {kind:(error as NodeJS.ErrnoException).code==='ENOENT'?'absent':'mismatch'};}
}
export function writeReport(manifest:LoggedManifest,intentId:string):void {
 writeExclusive(manifest.reportPath,JSON.stringify({format:1,runId:manifest.identity.runId,intentId,payloadDigest:manifest.payloadDigest,payload:manifest.payload}));
}

/** Presence only: an unreadable or non-file target is not counted as an observed effect. */
export function observedReportCount(manifest:LoggedManifest):0|1|null {
 try{return lstatSync(manifest.reportPath).isFile()?1:null;}catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT'?0:null;}
}
