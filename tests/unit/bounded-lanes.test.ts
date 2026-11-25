import { describe, expect, it } from 'vitest';

import { TwoLaneDelivery } from '../../src/control/bounded-lanes.js';
import { OutputLimitError } from '../../src/public/errors.js';

interface PublicEvent {
  kind: string;
  payload?: string;
}

interface CriticalItem {
  kind: 'result' | 'interaction';
  id: string;
}

describe('TwoLaneDelivery', () => {
  it('delivers critical items even when the public lane is full', async () => {
    const lanes = new TwoLaneDelivery<CriticalItem, PublicEvent>({
      publicLane: { maxItems: 2, overflow: 'fail' },
    });

    lanes.publishEvent({ kind: 'delta' });
    lanes.publishEvent({ kind: 'delta' });
    expect(() => lanes.publishEvent({ kind: 'delta' })).toThrow(OutputLimitError);

    lanes.pushCritical({ kind: 'result', id: 'turn-1' });
    lanes.pushCritical({ kind: 'interaction', id: 'int-1' });
    lanes.close();

    const critical: CriticalItem[] = [];
    for await (const item of lanes.criticalLane) critical.push(item);
    expect(critical).toEqual([
      { kind: 'result', id: 'turn-1' },
      { kind: 'interaction', id: 'int-1' },
    ]);
  });

  it('propagates fail to both lanes', async () => {
    const lanes = new TwoLaneDelivery<CriticalItem, PublicEvent>();
    const failure = new Error('transport lost');
    lanes.fail(failure);

    await expect(lanes.criticalLane[Symbol.asyncIterator]().next()).rejects.toBe(failure);
    await expect(lanes.publicLane[Symbol.asyncIterator]().next()).rejects.toBe(failure);
  });

  it('still delivers a terminal critical item after a public overflow failure', async () => {
    const lanes = new TwoLaneDelivery<CriticalItem, PublicEvent>({
      publicLane: { maxItems: 1, overflow: 'fail' },
    });

    lanes.publishEvent({ kind: 'delta' });
    expect(() => lanes.publishEvent({ kind: 'delta' })).toThrow(OutputLimitError);

    lanes.pushCritical({ kind: 'result', id: 'turn-terminal' });
    lanes.close();

    const item = await lanes.criticalLane[Symbol.asyncIterator]().next();
    expect(item.value).toEqual({ kind: 'result', id: 'turn-terminal' });
  });
});
