import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, symlinkSync, linkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPrivateFile } from '../dist/logged-storage.js';
function fixture(body){const directory=mkdtempSync(join(tmpdir(),'triage-bounded-read-')),file=join(directory,'private');try{writeFileSync(file,'small',{mode:0o600});body({directory,file});}finally{mock.restoreAll();syncBuiltinESMExports();rmSync(directory,{recursive:true,force:true});}}
test('controlled file growth never invokes an unbounded whole-FD read',()=>fixture(({file})=>{
 const stat=fs.fstatSync,whole=fs.readFileSync;let grew=false,wholeBytes=0;
 mock.method(fs,'fstatSync',function(fd,...options){const result=stat.call(this,fd,...options);if(!grew){grew=true;appendFileSync(file,Buffer.alloc(256*1024));}return result;});
 mock.method(fs,'readFileSync',function(...args){const result=whole.apply(this,args);wholeBytes+=Buffer.byteLength(result);return result;});syncBuiltinESMExports();
 assert.throws(()=>readPrivateFile(file,1024));assert.equal(grew,true);assert.equal(wholeBytes,0,'must reject growth with bounded reads, not allocate the grown file');
}));
test('private reads preserve bytes at cap and reject oversize, symlink, hardlink and forged descriptors',()=>fixture(({directory,file})=>{
 assert.equal(readPrivateFile(file,5),'small');assert.throws(()=>readPrivateFile(file,4));
 symlinkSync(file,join(directory,'symbolic'));assert.throws(()=>readPrivateFile(join(directory,'symbolic'),5));
 linkSync(file,join(directory,'hard'));assert.throws(()=>readPrivateFile(file,5));let getters=0;
 assert.throws(()=>readPrivateFile({get toString(){getters++;return ()=>file;}},5));assert.equal(getters,0);
 assert.throws(()=>readPrivateFile(file,{get valueOf(){getters++;return ()=>1024;}}));assert.equal(getters,0);
}));
test('a replaced path is refused even when the original opened FD remains unchanged',()=>fixture(({directory,file})=>{
 const stat=fs.fstatSync;let replaced=false;mock.method(fs,'fstatSync',function(fd,...options){const result=stat.call(this,fd,...options);if(!replaced){replaced=true;renameSync(file,join(directory,'old'));writeFileSync(file,'small',{mode:0o600});}return result;});syncBuiltinESMExports();
 assert.throws(()=>readPrivateFile(file,1024));assert.equal(replaced,true);
}));
