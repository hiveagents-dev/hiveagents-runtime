import type { ExecOperation } from '../adapters/provider.js';
import { compileContext } from '../orchestration/context/compiler.ts';
import { deliverPinned } from '../orchestration/context/delivery.ts';
import type { ConstraintStore } from '../orchestration/context/constraint-store.ts';
import { isConstraintStore } from '../orchestration/context/constraint-store.ts';
import { NothingPinnedError, type ConstraintExpectation } from '../orchestration/context/types.ts';
import * as check from '../orchestration/context/validation.ts';
import type { SessionConfig } from './config.js';
import { PinnedGuaranteeUnavailableError } from '../public/errors.js';
import type { AgentOptions, PinnedOption, PinnedTurnNote, RuntimeWarning, TransportKind } from '../public/types.js';

/** What the Session knows about one turn that decides how the constraints are delivered. */
export interface PinnedTurnInput {
  modelId: string;
  provider: string;
  transport: TransportKind;
  mode: ExecOperation | 'control';
  cliVersion?: string;
  instructions?: string;
  providerOptions?: Record<string, unknown>;
}

/** The turn's instruction channel as the constraints leave it, and the record of what happened. */
export interface PinnedApplied {
  instructions?: string;
  providerOptions?: Record<string, unknown>;
  note: PinnedTurnNote;
}

/** The note of the request that `buildExecRequest` made, for the code that completes that turn. */
export const requestNotes = new WeakMap<object, PinnedTurnNote>();

const OPTIONAL = ['require', 'allowEmpty', 'allowUnpinned'];
/** Room for the largest pinned channel plus the placeholder task the compiler requires. */
const COMPILE_BUDGET_BYTES = check.MAX_PINNED_BYTES + 1024;

function flag(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== 'boolean') throw new TypeError(`${field} must be true or false`);
}

/**
 * The pinned option of one Agent, shared by its sessions. It compiles the constraints for every
 * turn from the store, remembers the versions earlier turns saw (so a store that later shows
 * less stops the turn), and decides between delivery, refusal and a recorded opt-out.
 */
export class PinnedTurns {
  readonly #store: ConstraintStore;
  readonly #scopes: readonly string[];
  readonly #allowEmpty: boolean;
  readonly #allowUnpinned: boolean;
  #require: readonly ConstraintExpectation[];

  constructor(option: PinnedOption) {
    check.closed(option, ['constraints', 'scopes', ...OPTIONAL], OPTIONAL, 'The pinned option');
    // The brand of a real store, checked without loading the store module or node:sqlite.
    if (!isConstraintStore(option.constraints)) throw new TypeError('pinned.constraints must be a ConstraintStore');
    check.scopes(option.scopes);
    flag(option.allowEmpty, 'pinned.allowEmpty');
    flag(option.allowUnpinned, 'pinned.allowUnpinned');
    this.#store = option.constraints;
    this.#scopes = [...option.scopes];
    this.#allowEmpty = option.allowEmpty === true;
    this.#allowUnpinned = option.allowUnpinned === true;
    this.#require = [...(option.require ?? [])];
    // A bad `require` fails when the Agent is built, not on its first turn.
    this.#compile();
  }

  #compile() {
    return compileContext({
      constraints: this.#store, scopes: this.#scopes, task: { instructions: 'turn' },
      budget: { maxBytes: COMPILE_BUDGET_BYTES }, require: this.#require,
    });
  }

  /** Reads, verifies and delivers for one turn. Throws before the CLI runs when it must not. */
  apply(input: PinnedTurnInput): PinnedApplied { return this.#decide(input, true); }

  /**
   * The refusals `apply` would make now, without delivering or recording the versions seen: the
   * pre-flight of a turn that recalls memory first. That turn calls `apply` once recall is done,
   * so it runs with the constraints current when it starts, never older ones another turn saw.
   */
  check(input: PinnedTurnInput): void { this.#decide(input, false); }

  #decide(input: PinnedTurnInput, deliver: boolean): PinnedApplied {
    const compiled = this.#compile();
    if (deliver) this.#require = compiled.seen;
    const known = input.provider === 'claude' || input.provider === 'codex';
    const options: AgentOptions = {
      model: input.modelId,
      transport: input.transport,
      ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
      ...(known && input.providerOptions !== undefined ? { providerOptions: { [input.provider]: input.providerOptions } } : {}),
    };
    const delivery = deliverPinned({
      options, pinned: compiled.pinned, turn: input.mode === 'resume' || input.mode === 'fork' ? 'resume' : 'fresh',
      ...(input.cliVersion === undefined ? {} : { cliVersion: input.cliVersion }),
    });
    if (delivery.status === 'nothing-pinned') return this.#empty(input);
    if (delivery.status === 'unverified-channel') return this.#unverified(input, delivery.reason, compiled.pinned.digest);
    const own = (delivery.options.providerOptions as Record<string, Record<string, unknown>> | undefined)?.[input.provider];
    return {
      ...(delivery.options.instructions === undefined ? {} : { instructions: delivery.options.instructions }),
      ...(own === undefined || !known ? {} : { providerOptions: own }),
      note: {
        status: 'pinned', provider: input.provider, channel: delivery.channel.id, digest: delivery.digest,
        carried: delivery.carried.map(({ scope, id, version }) => ({ scope, id, version })),
      },
    };
  }

  #empty(input: PinnedTurnInput): PinnedApplied {
    if (!this.#allowEmpty) {
      throw new NothingPinnedError('No constraint is active in the requested scopes; the turn would run without any pinned rule');
    }
    return { note: { status: 'nothing-pinned', provider: input.provider } };
  }

  #unverified(input: PinnedTurnInput, reason: string, digest: string): PinnedApplied {
    if (!this.#allowUnpinned) {
      throw new PinnedGuaranteeUnavailableError({
        provider: input.provider, transport: input.transport, retryable: false,
        ...(input.cliVersion === undefined ? {} : { cliVersion: input.cliVersion }),
      }, reason);
    }
    return { note: { status: 'unpinned', provider: input.provider, reason, digest } };
  }
}

/** The turn as it left, with what the pinned option did recorded in warnings and metadata. */
export function annotateTurn<T extends { warnings: RuntimeWarning[]; providerMetadata: unknown }>(turn: T, note: PinnedTurnNote | undefined): T {
  if (note === undefined) return turn;
  const metadata = typeof turn.providerMetadata === 'object' && turn.providerMetadata !== null ? turn.providerMetadata : {};
  const warnings = note.status !== 'unpinned' ? turn.warnings : [
    ...turn.warnings,
    { code: 'PINNED_UNAVAILABLE', message: `This turn ran without the pinned constraints: ${note.reason}` },
  ];
  return { ...turn, warnings, providerMetadata: { ...metadata, pinned: note } };
}

function controlInput(config: SessionConfig): PinnedTurnInput {
  return {
    modelId: config.model.id, provider: config.adapter.id, transport: config.transport, mode: 'control',
    ...(config.cliVersion === undefined ? {} : { cliVersion: config.cliVersion }),
  };
}

/** The gate of a control turn: `apply` for the control transport, which has no verified channel. */
export function controlNote(config: SessionConfig): PinnedTurnNote | undefined {
  return config.pinned?.apply(controlInput(config)).note;
}

/** The refusals of `controlNote`, made in a turn's pre-flight before memory recalls. */
export function checkControl(config: SessionConfig): void {
  config.pinned?.check(controlInput(config));
}
