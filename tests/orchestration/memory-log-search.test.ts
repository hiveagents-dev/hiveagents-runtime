import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendTexts, episode, memoryWorkspace, scopeOf } from './memory-store-fixture.js';

let workspace: ReturnType<typeof memoryWorkspace>;
beforeEach(() => { workspace = memoryWorkspace(); });
afterEach(() => { workspace.cleanup(); });

async function enabled(systemId: string) {
  const memory = workspace.open(systemId);
  await memory.enable({ by: 'operator' });
  return memory;
}

describe('search over the raw run log', () => {
  it('finds a system\'s own entries by text and returns the log position as provenance', async () => {
    const log = workspace.openLog('grow');
    const receipt = await appendTexts(log, 'grow', 'one', [
      'El cliente pidió una factura en pesos',
      'Reunión de seguimiento sin novedades',
    ]);
    const memory = await enabled('grow');

    const result = await memory.searchLog(log, { text: 'factura' });

    expect(result.matches).toHaveLength(1);
    const match = result.matches[0]!;
    expect(match.position).toEqual(receipt.first);
    expect(match.position.sourceId).toBe(log.sourceId);
    expect(match.entry.record.payload).toEqual({ inline: { text: 'El cliente pidió una factura en pesos' } });
    expect(match.text).toContain('factura');
    expect(match.score).toBeGreaterThan(0);
    expect(result.scanned).toBe(2);
    expect(result.complete).toBe(true);
  });

  it('folds case and accents, matches whole words, and returns nothing without a match', async () => {
    const log = workspace.openLog('grow');
    await appendTexts(log, 'grow', 'one', ['Diseño de la campaña de WordPress']);
    const memory = await enabled('grow');

    expect((await memory.searchLog(log, { text: 'DISENO' })).matches).toHaveLength(1);
    expect((await memory.searchLog(log, { text: 'press' })).matches).toEqual([]);
    expect((await memory.searchLog(log, { text: 'inexistente' })).matches).toEqual([]);
    expect((await memory.searchLog(log, { text: '' })).matches).toEqual([]);
  });

  it('scans every page of the log, not only the first', async () => {
    const log = workspace.openLog('grow');
    const filler = Array.from({ length: 200 }, (_, index) => `relleno ${index}`);
    await appendTexts(log, 'grow', 'one', filler);
    const late = await appendTexts(log, 'grow', 'two', [...filler.slice(0, 149), 'la aguja del pajar']);
    const memory = await enabled('grow');

    const result = await memory.searchLog(log, { text: 'aguja' });

    expect(result.scanned).toBe(350);
    expect(result.complete).toBe(true);
    expect(result.matches.map(match => match.position)).toEqual([late.head]);
  });

  it('bounds one scan and hands back a cursor that continues where it stopped', async () => {
    const log = workspace.openLog('grow');
    const filler = Array.from({ length: 100 }, (_, index) => `relleno ${index}`);
    const receipt = await appendTexts(log, 'grow', 'one', [...filler, 'la aguja del pajar']);
    const memory = await enabled('grow');

    const first = await memory.searchLog(log, { text: 'aguja', maxScanned: 64 });
    expect(first.matches).toEqual([]);
    expect(first.scanned).toBe(64);
    expect(first.complete).toBe(false);
    expect(first.nextCursor).toBeDefined();

    const second = await memory.searchLog(log, { text: 'aguja', maxScanned: 64, cursor: first.nextCursor! });
    expect(second.complete).toBe(true);
    expect(second.matches.map(match => match.position)).toEqual([receipt.head]);
  });

  it('limits the number of matches and ranks the most focused entry first', async () => {
    const log = workspace.openLog('grow');
    await appendTexts(log, 'grow', 'one', [
      'pago pendiente y muchas otras cosas sin relación con el tema principal',
      'pago rechazado',
      'pago aprobado con tarjeta',
    ]);
    const memory = await enabled('grow');

    const result = await memory.searchLog(log, { text: 'pago rechazado', limit: 2 });

    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]!.text).toContain('pago rechazado');
  });

  it('says how many matches a window held when it returns fewer, so paging cannot lose them unnoticed', async () => {
    const log = workspace.openLog('grow');
    await appendTexts(log, 'grow', 'one', Array.from({ length: 60 }, (_, index) => `cobranza caso ${index}`));
    const memory = await enabled('grow');

    const first = await memory.searchLog(log, { text: 'cobranza', limit: 5, maxScanned: 30 });
    expect(first.matches).toHaveLength(5);
    expect(first).toMatchObject({ scanned: 30, found: 30, truncated: true, complete: false });

    const second = await memory.searchLog(log, { text: 'cobranza', limit: 5, maxScanned: 30, cursor: first.nextCursor! });
    expect(second.matches).toHaveLength(5);
    // The scan reached the head of the log, and still says that it did not return everything it found.
    expect(second).toMatchObject({ scanned: 30, found: 30, truncated: true, complete: true });
  });

  it('returns every match to a host that narrows a truncated window, and never truncates a window that fits', async () => {
    const log = workspace.openLog('grow');
    await appendTexts(log, 'grow', 'one', Array.from({ length: 60 }, (_, index) => `cobranza caso ${index}`));
    const memory = await enabled('grow');
    const limit = 5;
    const sequences: number[] = [];
    let cursor: Awaited<ReturnType<typeof memory.searchLog>>['nextCursor'];
    let complete = false;

    while (!complete) {
      const from = cursor ? { cursor } : {};
      let page = await memory.searchLog(log, { text: 'cobranza', limit, maxScanned: 30, ...from });
      // The documented way out: read the same window again, no wider than the limit.
      if (page.truncated) page = await memory.searchLog(log, { text: 'cobranza', limit, maxScanned: limit, ...from });
      expect(page.truncated).toBe(false);
      expect(page.found).toBe(page.matches.length);
      sequences.push(...page.matches.map(match => match.position.sequence));
      cursor = page.nextCursor;
      complete = page.complete;
    }

    expect(sequences.sort((a, b) => a - b)).toEqual(Array.from({ length: 60 }, (_, index) => index + 1));
  });

  it('does not count a withdrawn entry among the matches it found', async () => {
    const log = workspace.openLog('grow');
    const receipt = await appendTexts(log, 'grow', 'one', ['cobranza uno', 'cobranza dos', 'cobranza tres']);
    const memory = await enabled('grow');
    const provenance = { source: 'run-log', sourceVersion: '1', observedAt: '2026-11-10T10:00:00.000Z', logPosition: receipt.first };
    await memory.put(episode('grow', 'e1', 'cobranza uno', { provenance }));
    await memory.revoke({ scope: scopeOf('grow'), id: 'e1', revokedAt: '2026-11-10T11:00:00.000Z', reason: 'pedido del operador' });

    const result = await memory.searchLog(log, { text: 'cobranza', limit: 1 });

    expect(result).toMatchObject({ found: 2, truncated: true, scanned: 3, complete: true });
    expect(result.matches[0]!.position.sequence).not.toBe(receipt.first.sequence);
  });

  it('narrows the search to one run when asked', async () => {
    const log = workspace.openLog('grow');
    await appendTexts(log, 'grow', 'one', ['factura de la corrida general']);
    const memory = await enabled('grow');

    expect((await memory.searchLog(log, { text: 'factura', runId: 'run' })).matches).toHaveLength(1);
    expect((await memory.searchLog(log, { text: 'factura', runId: 'otra' })).matches).toEqual([]);
  });

  it('returns nothing from a log that belongs to another system', async () => {
    const foreign = workspace.openLog('marketing');
    await appendTexts(foreign, 'marketing', 'one', ['factura confidencial de marketing']);
    const memory = await enabled('grow');

    const result = await memory.searchLog(foreign, { text: 'factura' });

    expect(result.matches).toEqual([]);
    expect(result.scanned).toBe(0);
  });

  it('returns nothing while the system has not enabled memory', async () => {
    const log = workspace.openLog('grow');
    await appendTexts(log, 'grow', 'one', ['factura pendiente']);
    const memory = workspace.open('grow');

    expect((await memory.searchLog(log, { text: 'factura' })).matches).toEqual([]);

    await memory.enable({ by: 'operator' });
    expect((await memory.searchLog(log, { text: 'factura' })).matches).toHaveLength(1);
  });

  it('rejects malformed searches at the boundary', async () => {
    const log = workspace.openLog('grow');
    const memory = await enabled('grow');

    await expect(memory.searchLog(log, { text: 7 } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(memory.searchLog(log, { text: 'a', limit: 0 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(memory.searchLog(log, { text: 'a', maxScanned: 1e9 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(memory.searchLog({} as never, { text: 'a' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
