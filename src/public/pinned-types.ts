import type { ConstraintExpectation } from '../orchestration/context/types.js';
import type { ConstraintStore } from '../orchestration/context/constraint-store.js';
import type { ProviderId } from './types.js';

/**
 * Opt-in: the owner's pinned constraints reach every turn of this Agent, outside the
 * conversation. Each turn reads the store, verifies it and delivers the current versions on the
 * provider's verified channel (Claude exec: `--append-system-prompt`; Codex: a new `exec`
 * only). Where there is no verified channel the turn is refused with
 * `PinnedGuaranteeUnavailableError` before the CLI runs, unless `allowUnpinned` is set.
 *
 * With this option and no explicit transport the Agent uses `exec`, the only transport whose
 * delivery was examined. Nothing an agent writes can reach this option or its store.
 */
export interface PinnedOption {
  /** A reader: open it with `openSystemConstraintStore`. It is never written through here. */
  constraints: ConstraintStore;
  /** Which scopes apply to this Agent, for example `['host', 'system:grow']`. */
  scopes: readonly string[];
  /**
   * Versions the host knows the store must hold (its manifest). Later turns also require
   * whatever earlier turns of this Agent saw, so a store that loses versions stops the turn.
   */
  require?: readonly ConstraintExpectation[];
  /** The system really has no constraint yet; running with an empty store is not an error. */
  allowEmpty?: boolean;
  /**
   * Run turns that have no verified channel (Codex resume, control transport, other
   * providers) without the guarantee. Each such turn says so in `warnings` and in
   * `providerMetadata.pinned`.
   */
  allowUnpinned?: boolean;
}

/** What one turn did with the pinned option; found in `Turn.providerMetadata.pinned`. */
export type PinnedTurnNote =
  | {
      status: 'pinned';
      provider: ProviderId;
      channel: 'claude-append-system-prompt' | 'codex-developer-instructions';
      digest: string;
      carried: ReadonlyArray<{ scope: string; id: string; version: number }>;
    }
  | { status: 'nothing-pinned'; provider: ProviderId }
  | { status: 'unpinned'; provider: ProviderId; reason: string; digest: string };
