import { join } from 'node:path';
import { ConstraintStore } from './constraint-store.ts';
import * as check from './validation.ts';

export interface SystemConstraintStoreOptions {
  /** Absolute directory under which every system keeps its own folder. */
  root: string;
  /** The system's name, as the host calls it (`grow`, `strategy`). One folder per system. */
  system: string;
  /** Public half of the owner's authority. */
  publicKey: string;
  /** The id the host recorded for this system's store, when it keeps one. */
  storeId?: string;
}

/** Where the store of one system lives: `<root>/<system>/constraints.sqlite`. */
export function systemConstraintStorePath(root: string, system: string): string {
  check.databasePath(root);
  check.name(system, 'system');
  return join(root, system, 'constraints.sqlite');
}

/**
 * Opens the constraint store of one system for reading, to hand to the `pinned` option of an
 * Agent. It never creates anything: a missing, empty or foreign file fails with
 * `ConstraintIntegrityError`. Making the store is the owner's act (`ConstraintStore.create`).
 */
export function openSystemConstraintStore(options: SystemConstraintStoreOptions): ConstraintStore {
  check.closed(options, ['root', 'system', 'publicKey', 'storeId'], ['storeId'], 'The system store options');
  return new ConstraintStore({
    databasePath: systemConstraintStorePath(options.root, options.system),
    publicKey: options.publicKey,
    ...(options.storeId === undefined ? {} : { storeId: options.storeId }),
  });
}
