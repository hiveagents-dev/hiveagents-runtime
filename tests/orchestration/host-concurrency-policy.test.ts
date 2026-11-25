import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runCli } from '../../src/cli/run-cli.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { HostLedger } from '../../src/orchestration/budget/host-ledger.ts';

it('uses one durable concurrency policy across open clients, limit changes, waits and restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'oar-policy-')), databasePath = join(directory,'ledger.sqlite');
  const unlimited = {mode:'unlimited'} as const;
  const limited = (maxConcurrent:number) => ({mode:'limited' as const,maxConcurrent});
  const original = new HostLedger({ databasePath, concurrency:limited(3) });
  const client = new HostLedger({ databasePath, concurrency:unlimited });
  const reopened = new HostLedger({databasePath,concurrency:limited(0)});
  try {
    const holds = ['a','b','c'].map(id => original.reserve('claude',id));
    expect(holds.every(h => h.allowed)).toBe(true);
    expect(client.reserve('claude','fourth')).toMatchObject({allowed:false,reason:'concurrency-limit'});
    expect(client.status('claude')).toMatchObject({ok:true,status:{active:3,limits:{concurrency:limited(3)}}});
    const edit = (revision:number, concurrency: ReturnType<typeof limited> | typeof unlimited) =>
      original.setConcurrency('claude',{expectedRevision:revision,concurrency});
    expect(edit(0,limited(1))).toMatchObject({ok:true,policy:{revision:1}});
    expect(edit(0,limited(1))).toMatchObject({ok:true,policy:{revision:1}});
    expect(edit(0,unlimited)).toMatchObject({ok:false,reason:'configuration-mismatch'});
    for (const h of holds.slice(0,2)) { if (!h.allowed) throw Error(); expect(client.release(h.reservation.token).ok).toBe(true); }
    expect(client.reserve('claude','still-full')).toMatchObject({allowed:false,reason:'concurrency-limit'});
    const waiting = client.acquire('claude','waiting',{maxWaitMs:5000});
    await new Promise(resolve => setTimeout(resolve,40));
    expect(edit(1,unlimited).ok).toBe(true);
    expect((await waiting).allowed).toBe(true);
    expect(reopened.status('claude')).toMatchObject({ok:true,status:{active:2,launchesLastDay:4,limits:{concurrency:unlimited}}});
    expect(edit(2,limited(0)).ok).toBe(true);
    expect(await client.acquire('claude','disabled',{maxWaitMs:5000})).toMatchObject({allowed:false,reason:'concurrency-limit'});
    expect(client.status('claude')).toMatchObject({ok:true,status:{active:2,launchesLastDay:4}});
    const cooldown = original.recordQuotaError('claude');
    expect(cooldown.ok).toBe(true);
    expect(edit(3,limited(5)).ok).toBe(true);
    expect(reopened.reserve('claude','cooldown')).toMatchObject({allowed:false,reason:'quota-cooldown'});
    expect(original.getConcurrency('codex')).toMatchObject({ok:true,policy:{revision:0,concurrency:limited(3)}});
  } finally { for (const item of [original,client,reopened]) item.close(); rmSync(directory,{recursive:true,force:true}); }
});

it('serializes two independent operators and retains the winner across CLI and SDK reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'oar-policy-race-'));
  const file = join(directory, 'ledger.sqlite');
  const ledger = new HostLedger({databasePath: file});
  const cli = async (...args: string[]) => {
    let output = '';
    const write = (line: string) => { output += line; };
    const code = await runCli(['concurrency', ...args, '--database', file], {stdout: write, stderr: write});
    return {code, output};
  };
  try {
    const held = ledger.reserve('claude','in-flight');
    expect(held.allowed).toBe(true);
    const moduleUrl = new URL('../../src/orchestration/budget/host-ledger.ts', import.meta.url);
    const child = `
      import {HostLedger} from ${JSON.stringify(moduleUrl.href)};
      const ledger = new HostLedger({databasePath: process.argv[1]});
      try {
        const result = ledger.setConcurrency('claude', {
          expectedRevision: 0, concurrency: {mode:'limited', maxConcurrent:Number(process.argv[2])}
        });
        console.log(JSON.stringify(result));
      } finally { ledger.close(); }
    `;
    const results = await Promise.all([1,4].map(async limit => {
      const {stdout} = await promisify(execFile)(process.execPath,
        ['--experimental-strip-types','--input-type=module','-e',child,file,String(limit)]);
      return JSON.parse(stdout);
    }));
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.find(r => !r.ok)).toMatchObject({reason:'configuration-mismatch'});
    expect(JSON.parse((await cli('claude')).output)).toEqual(results.find(r => r.ok));
    expect((await cli('claude','0','--expected-revision','0')).code).toBe(1);
    expect((await cli('claude','unlimited','--expected-revision','1')).code).toBe(0);
    expect((await cli('claude','NaN')).code).toBe(2);
    expect(ledger.status('claude')).toMatchObject({ok:true,status:{active:1,launchesLastDay:1,limits:{concurrency:{mode:'unlimited'}}}});
    if (held.allowed) expect(ledger.release(held.reservation.token).ok).toBe(true);
  } finally { ledger.close(); rmSync(directory,{recursive:true,force:true}); }
});

it.each([['hourly-limit',1,10],['daily-limit',10,1]] as const)(
  'preserves an exhausted %s across an unlimited policy update', (reason, hourly, daily) => {
    const directory = mkdtempSync(join(tmpdir(), 'oar-policy-windows-'));
    const ledger = new HostLedger({databasePath:join(directory,'ledger.sqlite'), providers:{
      custom:{concurrency:{mode:'limited',maxConcurrent:1}, maxLaunchesPerHour:hourly, maxLaunchesPerDay:daily, quotaCooldownMs:100}
    }});
    try {
      const first = ledger.reserve('custom','first');
      expect(first.allowed).toBe(true);
      expect(ledger.setConcurrency('custom',{expectedRevision:0,concurrency:{mode:'unlimited'}}).ok).toBe(true);
      expect(ledger.reserve('custom','second')).toMatchObject({allowed:false,reason});
    } finally { ledger.close(); rmSync(directory,{recursive:true,force:true}); }
  });

it('retains the later of a confirmed vendor reset, the local cooldown and a previous pause', () => {
  const directory = mkdtempSync(join(tmpdir(), 'oar-observed-reset-'));
  const ledger = new HostLedger({databasePath: join(directory, 'ledger.sqlite')});
  try {
    const weekly = Date.now() + 7 * 86400000;
    expect(ledger.recordQuotaError('claude', weekly)).toEqual({ok:true,pausedUntil:weekly});
    expect(ledger.recordQuotaError('claude', Date.now()-1)).toEqual({ok:true,pausedUntil:weekly});
    expect(ledger.reserve('claude','probe')).toMatchObject({allowed:false,reason:'quota-cooldown',retryAt:weekly});
    expect(ledger.recordQuotaError('codex', Infinity)).toMatchObject({ok:false,reason:'invalid-input'});
    expect(ledger.reserve('codex','unaffected').allowed).toBe(true);
  } finally { ledger.close(); rmSync(directory,{recursive:true,force:true}); }
});
