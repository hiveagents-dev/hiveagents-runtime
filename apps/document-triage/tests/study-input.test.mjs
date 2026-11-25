import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
test('study JSON loader rejects FIFO without waiting for a writer or dispatching', async()=>{
  const directory=await mkdtemp(join(tmpdir(),'oar-study-fifo-'));
  try{const path=join(directory,'input');assert.equal(spawnSync('mkfifo',[path]).status,0);
    const script='import {readStudyJsonFile} from '+JSON.stringify(new URL('../dist/learning-study-session.js',import.meta.url).href)+'; await readStudyJsonFile(process.argv[1]);';
    const result=spawnSync(process.execPath,['--input-type=module','-e',script,path],{encoding:'utf8',timeout:2000});
    assert.equal(result.error,undefined,'FIFO read must reject before the subprocess deadline');assert.equal(result.status,1);assert.match(result.stderr,/regular file/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
