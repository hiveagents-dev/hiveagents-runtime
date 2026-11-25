import { codexDeveloperInstructionsEntry } from '../../adapters/codex/exec-adapter.js';
import { resolveModel } from '../../core/models.js';
import type { AgentOptions } from '../../public/types.js';
import { isCompiledPinned } from './compiler.ts';
import { ContextBudgetError, NothingPinnedError, UnverifiedPinnedChannelError, type PinnedChannel } from './types.ts';
import * as check from './validation.ts';

/**
 * Codex CLI versions whose `developer_instructions` delivery was measured on the wire
 * (scripts/contexto-canal-probe, receipt in docs/validation). Another version is not claimed
 * until the probe is run against it.
 */
export const CODEX_PROBED_VERSIONS: readonly string[] = ['0.153.4'];

/** Codex refuses a `--config` entry above this size. */
const CODEX_CONFIG_ENTRY_BYTES = 64 * 1024;

export interface PinnedDeliveryRequest {
  /** The options the caller would have used. They are copied, never changed. */
  options: AgentOptions;
  /** The `pinned` of a compiled context. Nothing else is accepted. */
  pinned: PinnedChannel;
  /** `fresh` starts a provider session; `resume` continues one (a fork counts as `resume`). */
  turn: 'fresh' | 'resume';
  /** The installed CLI version, as `agent.ready()` or `--version` reports it. Needed for Codex. */
  cliVersion?: string;
}

export interface PinnedChannelInfo {
  id: 'claude-append-system-prompt' | 'codex-developer-instructions';
  /**
   * `cli-flag`: the CLI's own system-prompt flag, passed by the core on every invocation.
   * `wire-probe`: seen in the request body, in the developer role, for the probed versions.
   */
  evidence: 'cli-flag' | 'wire-probe';
}

/** Options that carry the constraints on a channel outside the conversation. */
export interface PinnedDelivered {
  status: 'pinned';
  provider: string;
  channel: PinnedChannelInfo;
  /**
   * Valid for one send. Compile and deliver again for the next one: a `Session` keeps the
   * options it was opened with, so a second `send` on it would not carry a newer version.
   *
   * `transport` is always `'exec'` here, also when the caller left it unset: delivery was
   * examined for exec only, and `'auto'` could pick the control transport.
   */
  options: AgentOptions;
  /**
   * True for Codex. Use the options with `Agent.run` only, never with `openSession`: the
   * second send of a session is a `codex exec resume`, where the CLI does not send constraints.
   */
  oneShotOnly: boolean;
  carried: PinnedChannel['carried'];
  digest: string;
}

/**
 * No constraint is active in the requested scopes, so nothing was attached. This is also what a
 * lost store or a mistyped scope looks like; `requirePinned` refuses it unless told otherwise.
 */
export interface PinnedNothing {
  status: 'nothing-pinned';
  provider: string;
  /** A copy of the caller's options, unchanged. */
  options: AgentOptions;
  carried: PinnedChannel['carried'];
  digest: string;
}

/** There is no verified channel for this turn. The constraints were not attached to anything. */
export interface PinnedUnverified {
  status: 'unverified-channel';
  provider: string;
  reason: string;
}

export type PinnedDelivery = PinnedDelivered | PinnedNothing | PinnedUnverified;

function unverified(provider: string, reason: string): PinnedUnverified {
  return { status: 'unverified-channel', provider, reason };
}

function providerOf(model: string): string {
  try {
    return resolveModel(model).provider;
  } catch {
    return model.includes('/') ? model.slice(0, model.indexOf('/')) : 'unknown';
  }
}

function joined(own: string | undefined, pinned: string): string {
  return own === undefined || own.length === 0 ? pinned : `${own}\n\n${pinned}`;
}

/** True when a whole word of `cliVersion` is a probed version: `0.153.4-alpha.2` is not `0.153.4`. */
function probedCodex(cliVersion: string | undefined): boolean {
  const words = cliVersion === undefined ? [] : cliVersion.split(/\s+/);
  return words.some((word) => CODEX_PROBED_VERSIONS.includes(word));
}

/**
 * Codex exec sends `instructions` as `developer_instructions`, in the developer role (exec-adapter.ts). The constraints
 * go there, joined after the caller's own developer instructions, whichever of the two places the caller used.
 */
function codexOptions(options: AgentOptions, pinned: string): AgentOptions {
  const codex = options.providerOptions?.codex ?? {};
  const { developer_instructions: fromConfig, ...config } = codex.config ?? {};
  if (fromConfig !== undefined && typeof fromConfig !== 'string') {
    throw new TypeError('providerOptions.codex.config.developer_instructions must be a string');
  }
  if (fromConfig !== undefined && options.instructions !== undefined) {
    throw new TypeError('Codex developer instructions are given twice: as instructions and as config.developer_instructions');
  }
  const text = joined(options.instructions ?? fromConfig, pinned);
  if (check.bytes(codexDeveloperInstructionsEntry(text)) > CODEX_CONFIG_ENTRY_BYTES) {
    throw new ContextBudgetError('The pinned constraints do not fit the 64 KiB Codex accepts in one config entry');
  }
  if (fromConfig === undefined) return { ...options, transport: 'exec', instructions: text };
  // The caller's own developer instructions move into `instructions`: Codex takes one value, not two.
  const { config: _, ...rest } = codex;
  const moved = Object.keys(config).length ? { ...rest, config } : rest;
  return { ...options, transport: 'exec', instructions: text, providerOptions: { ...options.providerOptions, codex: moved } };
}

/**
 * Attaches the compiled constraints to the provider's instruction channel for one turn.
 *
 * Claude exec: `instructions`, which the core passes as `--append-system-prompt` on every
 * invocation, new or resumed. Codex exec, new session only: `instructions` too, which the core
 * passes as `--config developer_instructions=…` and the CLI sends in the developer role. A
 * resumed Codex session replays the value it started with and ignores a new one, so that case, the control transport, an unprobed Codex version
 * and any other provider return `unverified-channel` and no options at all.
 *
 * `turn` is the caller's word; nothing here can see what the caller does with the options.
 * For Codex the result is marked `oneShotOnly`. With no active constraint the result is
 * `nothing-pinned`, never `pinned`.
 */
export function deliverPinned(request: PinnedDeliveryRequest): PinnedDelivery {
  check.closed(request, ['options', 'pinned', 'turn', 'cliVersion'], ['cliVersion'], 'A pinned delivery request');
  const { options, pinned, turn, cliVersion } = request;
  if (typeof options !== 'object' || options === null || typeof options.model !== 'string') {
    throw new TypeError('options must be AgentOptions with a model');
  }
  if (turn !== 'fresh' && turn !== 'resume') {
    throw new TypeError("turn must be 'fresh' or 'resume'");
  }
  if (cliVersion !== undefined && typeof cliVersion !== 'string') {
    throw new TypeError('cliVersion must be a string');
  }
  if (!isCompiledPinned(pinned)) {
    throw new TypeError('pinned must be the pinned channel of a compiled context');
  }
  const provider = providerOf(options.model);
  const carried = { carried: pinned.carried, digest: pinned.digest };
  if (pinned.text === '') {
    return { status: 'nothing-pinned', provider, options: { ...options }, ...carried };
  }
  if (options.transport === 'control') {
    return unverified(provider, 'Pinned delivery was examined for the exec transport only');
  }
  if (provider === 'claude') {
    return {
      status: 'pinned',
      provider,
      channel: { id: 'claude-append-system-prompt', evidence: 'cli-flag' },
      options: { ...options, transport: 'exec', instructions: joined(options.instructions, pinned.text) },
      oneShotOnly: false,
      ...carried,
    };
  }
  if (provider !== 'codex') {
    return unverified(provider, `No instruction channel is known for provider ${provider}`);
  }
  if (turn === 'resume') {
    return unverified(provider, 'codex exec resume replays the developer instructions the session started with and does not send new ones');
  }
  if (!probedCodex(cliVersion)) {
    return unverified(provider, `developer_instructions delivery was probed for codex ${CODEX_PROBED_VERSIONS.join(', ')} only`);
  }
  return {
    status: 'pinned',
    provider,
    channel: { id: 'codex-developer-instructions', evidence: 'wire-probe' },
    options: codexOptions(options, pinned.text),
    oneShotOnly: true,
    ...carried,
  };
}

/**
 * The delivery a turn may run with. Throws `UnverifiedPinnedChannelError` when there is no
 * verified channel, and `NothingPinnedError` when no constraint was active, unless the caller
 * passes `{ allowEmpty: true }` because it knows this system has none.
 */
export function requirePinned(delivery: PinnedDelivery): PinnedDelivered;
export function requirePinned(delivery: PinnedDelivery, allow: { allowEmpty: boolean }): PinnedDelivered | PinnedNothing;
export function requirePinned(delivery: PinnedDelivery, allow?: { allowEmpty: boolean }): PinnedDelivered | PinnedNothing {
  if (allow !== undefined) {
    check.closed(allow, ['allowEmpty'], [], 'The second argument of requirePinned');
    if (typeof allow.allowEmpty !== 'boolean') {
      throw new TypeError('allowEmpty must be true or false');
    }
  }
  if (delivery.status === 'unverified-channel') {
    throw new UnverifiedPinnedChannelError(`${delivery.provider}: ${delivery.reason}`);
  }
  if (delivery.status === 'nothing-pinned' && allow?.allowEmpty !== true) {
    throw new NothingPinnedError('No constraint is active in the requested scopes; the turn would run without any pinned rule');
  }
  return delivery;
}
