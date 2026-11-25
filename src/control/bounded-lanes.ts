import { BoundedQueue, type BoundedQueueOptions } from './bounded-queue.js';

export interface TwoLaneDeliveryOptions<TCritical, TPublic> {
  criticalLane?: BoundedQueueOptions<TCritical>;
  publicLane?: BoundedQueueOptions<TPublic>;
}

/**
 * Two independent delivery lanes over one transport: terminal results and
 * interaction requests ride the critical lane, which a slow or absent
 * public-event consumer can never fill or block. The critical lane still has
 * a (generous) cap so a runaway provider cannot grow RSS without bound.
 */
export class TwoLaneDelivery<TCritical, TPublic> {
  readonly criticalLane: BoundedQueue<TCritical>;
  readonly publicLane: BoundedQueue<TPublic>;

  constructor(options: TwoLaneDeliveryOptions<TCritical, TPublic> = {}) {
    this.criticalLane = new BoundedQueue<TCritical>({
      maxItems: 4096,
      maxBytes: 64 * 1024 * 1024,
      overflow: 'fail',
      ...options.criticalLane,
    });
    this.publicLane = new BoundedQueue<TPublic>(options.publicLane ?? {});
  }

  pushCritical(item: TCritical): void {
    this.criticalLane.push(item);
  }

  publishEvent(event: TPublic): void {
    this.publicLane.push(event);
  }

  close(): void {
    this.criticalLane.close();
    this.publicLane.close();
  }

  fail(error: unknown): void {
    this.criticalLane.fail(error);
    this.publicLane.fail(error);
  }
}
