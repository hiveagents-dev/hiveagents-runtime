import { describe, expect, it } from 'vitest';

import type { AdapterStreamItem, ExecAdapter, ExecTurnRequest, ProtocolResult } from '../../src/adapters/provider.js';
import { BoundedQueue } from '../../src/control/bounded-queue.js';
import { InteractionBroker } from '../../src/control/interaction-broker.js';
import { CONTROL_TRANSPORTS, type ControlAdapterRegistration } from '../../src/core/registry.js';
import { Runtime } from '../../src/core/runtime.js';
import { Agent } from '../../src/public/agent.js';
import {
  ApprovalRequiredError,
  TimeoutError,
  SessionInterruptedError,
  UnsupportedCapabilityError,
} from '../../src/public/errors.js';
import type {
  AgentEvent,
  InteractionRequest,
  InteractionResponse,
  InterruptReceipt,
  SessionIdentity,
  SessionPersistence,
  SupportLevel,
} from '../../src/public/types.js';
import {
  toBrokerResponse,
  type ControlSessionHandle,
  type ControlSessionState,
  type ControlTurnHandle,
  type ControlTurnRequest,
} from '../../src/session/control-session.js';

class FakeExecAdapter implements ExecAdapter {
  readonly id = 'claude' as const;

  async detect() {
    return { installed: true, path: '/bin/claude', realpath: '/bin/claude', version: '1.0.0' };
  }

  async auth() {
    return { authenticated: true, source: 'subscription' as const };
  }

  async models() {
    return [];
  }

  async execute(_request: ExecTurnRequest): Promise<ProtocolResult> {
    throw new Error('the control transport must never fall back to exec');
  }
}

interface TurnPlan {
  /** Events published before the turn terminates. */
  events?: AgentEvent[];
  /** Raise one tool approval through the broker before terminating. */
  approval?: boolean;
  /** Terminate only once interrupt() or death() is called. */
  hang?: boolean;
  text?: string;
}

/**
 * A control adapter reduced to the seam: a real InteractionBroker, a bounded
 * inbox, and a scripted turn. It stands in for both shipped factories so the
 * runtime wiring is tested without a live binary or the optional SDK.
 */
class FakeControlSession implements ControlSessionHandle {
  readonly transportEpoch = 'epoch-1';
  readonly broker: InteractionBroker;
  identity: SessionIdentity | undefined;
  plan: TurnPlan = {};
  steerable = false;
  steered: string[] = [];
  closed = false;
  forks = 0;
  #state: ControlSessionState = 'active';
  #inbox: BoundedQueue<AdapterStreamItem> | undefined;
  #settleTerminal: (() => void) | undefined;
  #persistence: SessionPersistence;
  #threadId: string;

  constructor(threadId: string, persistence: SessionPersistence, eager: boolean) {
    this.#threadId = threadId;
    this.#persistence = persistence;
    this.broker = new InteractionBroker({ provider: 'claude', epoch: this.transportEpoch });
    if (eager) {
      this.identity = {
        schemaVersion: 1,
        provider: 'claude',
        id: threadId,
        cwd: process.cwd(),
        transport: 'control',
        persistence,
        transportEpoch: this.transportEpoch,
        createdAt: new Date().toISOString(),
      };
    }
  }

  state(): ControlSessionState {
    return this.#state;
  }

  /** The transport died underneath an in-flight turn. */
  death(): void {
    this.#state = this.#persistence === 'provider' ? 'unknown' : 'failed';
    this.broker.expireAll('epoch-2');
    this.#inbox?.fail(new Error('control transport died'));
  }

  async startTurn(request: ControlTurnRequest): Promise<ControlTurnHandle> {
    const inbox = new BoundedQueue<AdapterStreamItem>({ maxItems: 8192 });
    this.#inbox = inbox;
    inbox.push({ kind: 'session', sessionId: this.#threadId });
    for (const event of this.plan.events ?? []) inbox.push({ kind: 'event', event });
    const terminal = () => inbox.push({
      kind: 'result',
      result: {
        completed: true,
        failed: false,
        refused: false,
        sessionId: this.#threadId,
        turnId: 'turn-1',
        text: this.plan.text ?? 'ok',
        events: [],
        nativeEvents: [],
      },
    });
    const finish = () => {
      terminal();
      inbox.close();
    };
    if (this.plan.approval) this.#raiseApproval(inbox, request, finish);
    else if (this.plan.hang) this.#settleTerminal = finish;
    else finish();
    return {
      stream: inbox,
      interrupt: async (): Promise<InterruptReceipt> => {
        // Terminal-gated: the receipt reports what the transport actually
        // produced, never the bare acknowledgement of the interrupt request.
        this.#settleTerminal?.();
        this.#settleTerminal = undefined;
        return { requested: true, terminal: 'interrupted' };
      },
      ...(this.steerable
        ? {
            steer: async (input: string | unknown[]) => {
              this.steered.push(typeof input === 'string' ? input : JSON.stringify(input));
              return { accepted: true, turnId: 'turn-1' };
            },
          }
        : {}),
    };
  }

  #raiseApproval(
    inbox: BoundedQueue<AdapterStreamItem>,
    request: ControlTurnRequest,
    finish: () => void,
  ): void {
    const handle = this.broker.register({
      method: 'canUseTool',
      sessionId: this.#threadId,
      turnId: 'turn-1',
      payload: { toolName: 'Bash' },
      availableDecisions: ['allow', 'deny'],
      settle: async (response) => {
        inbox.push({
          kind: 'event',
          event: { type: 'tool.completed', id: 'tool-1', output: response.decision },
        });
        finish();
      },
    });
    const interaction: InteractionRequest = {
      kind: 'tool-approval',
      toolName: 'Bash',
      input: { command: 'ls' },
      binding: handle.binding,
      availableDecisions: handle.availableDecisions,
      signal: handle.signal,
    };
    inbox.push({ kind: 'event', event: { type: 'interaction.requested', request: interaction } });
    if (!request.onInteraction) {
      // Missing handler: settle the wire first, then surface the typed error.
      this.broker.expire(handle.binding.interactionId, 'No interaction handler registered');
      inbox.fail(new ApprovalRequiredError(
        { provider: 'claude', transport: 'control', retryable: false },
        'No interaction handler for tool approval "Bash"',
      ));
      return;
    }
    void request.onInteraction(interaction)
      .then((response) => this.broker.respond(
        handle.binding.interactionId,
        toBrokerResponse(response),
      ))
      .catch(() => undefined);
  }

  async respond(interactionId: string, response: Parameters<ControlSessionHandle['respond']>[1]) {
    await this.broker.respond(interactionId, toBrokerResponse(response));
  }

  async fork(): Promise<ControlSessionHandle> {
    this.forks += 1;
    const child = new FakeControlSession(`${this.#threadId}-fork`, this.#persistence, true);
    child.plan = { text: 'forked' };
    return child;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.#state = 'closed';
  }
}

const VERDICTS: Readonly<Record<string, SupportLevel>> = Object.freeze({
  interactiveApprovals: 'full',
  steering: 'none',
  processPersistence: 'full',
  messageDeltas: 'full',
});

function registration(
  session: FakeControlSession | undefined,
  verdicts = VERDICTS,
): ControlAdapterRegistration {
  return {
    token: 'claudeControlV1',
    provider: 'claude',
    packageName: CONTROL_TRANSPORTS.claude.packageName,
    adapterVersion: '0.1.0',
    capabilityVerdicts: verdicts,
    evidenceSource: 'sdk-capability',
    ...(session === undefined ? {} : { createSession: async () => session }),
  };
}

function agentFor(control: ControlAdapterRegistration, persistence?: SessionPersistence) {
  const runtime = new Runtime({ adapters: [new FakeExecAdapter()], controlAdapters: [control] });
  const agent = new Agent({
    model: 'opus-5',
    transport: 'control',
    providerOptions: { experimentalControl: true },
  }, runtime);
  return { agent, persistence };
}

describe('control session wiring', () => {
  it('preserves the compound Agent deadline as TIMEOUT during control execution', async () => {
    const control = new FakeControlSession('deadline-thread', 'provider', true);
    control.plan = { hang: true };
    const { agent } = agentFor(registration(control));
    const session = await agent.openSession();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new TimeoutError({ provider: 'claude', retryable: true })), 10);
    try { await expect(session.send('wait', { timeoutMs: 1000, signal: controller.signal })).rejects.toMatchObject({ code: 'TIMEOUT' }); }
    finally { clearTimeout(timer); await session.close(); }
  });
  it('drives a control turn from open through terminal result and close', async () => {
    const control = new FakeControlSession('thread-1', 'provider', true);
    control.plan = { events: [{ type: 'message.delta', text: 'partial' }], text: 'done' };
    const { agent } = agentFor(registration(control));

    const session = await agent.openSession();
    expect(session.ref).toMatchObject({ id: 'thread-1', transport: 'control', transportEpoch: 'epoch-1' });

    const turn = await session.send('hello');
    expect(turn).toMatchObject({ id: 'turn-1', status: 'completed', text: 'done' });
    expect(turn.events.map((event) => event.type)).toEqual(['message.delta']);
    expect(session.state).toBe('idle');

    await session.close();
    expect(control.closed).toBe(true);
    expect(session.state).toBe('closed');
  });

  it('streams control events live and adopts a lazily minted native id', async () => {
    const control = new FakeControlSession('thread-lazy', 'provider', false);
    control.plan = { events: [{ type: 'message.delta', text: 'chunk' }] };
    const { agent } = agentFor(registration(control));
    const session = await agent.openSession();

    const seen: AgentEvent[] = [];
    for await (const event of session.stream('hello')) seen.push(event);

    expect(seen.map((event) => event.type))
      .toEqual(['session.started', 'message.delta', 'turn.completed']);
    expect(session.ref?.id).toBe('thread-lazy');
    expect(session.ref?.transportEpoch).toBe('epoch-1');
  });

  it('omits steer from the turn handle unless steering was negotiated', async () => {
    const noSteer = new FakeControlSession('thread-1', 'provider', true);
    noSteer.plan = { hang: true };
    const { agent } = agentFor(registration(noSteer));
    const withoutSteering = (await agent.openSession()).start('hello');
    expect(withoutSteering.steer).toBeUndefined();
    await withoutSteering.interrupt();
    await withoutSteering.result;

    const steerable = new FakeControlSession('thread-2', 'provider', true);
    steerable.steerable = true;
    steerable.plan = { hang: true };
    const steeringAgent = agentFor(registration(steerable, { ...VERDICTS, steering: 'full' })).agent;
    const session = await steeringAgent.openSession();
    const handle = session.start('hello');

    expect(handle.steer).toBeTypeOf('function');
    await expect(handle.steer?.('also do this')).resolves.toMatchObject({ accepted: true });
    await session.steer('and this');
    expect(steerable.steered).toEqual(['also do this', 'and this']);

    await handle.interrupt();
    await handle.result;
  });

  it('refuses Session.steer when the negotiated verdict is none', async () => {
    const control = new FakeControlSession('thread-1', 'provider', true);
    control.steerable = true;
    control.plan = { hang: true };
    const { agent } = agentFor(registration(control));
    const session = await agent.openSession();
    const handle = session.start('hello');

    await expect(session.steer('nope')).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await handle.interrupt();
    await handle.result;
  });

  it('gates the interrupt receipt on the terminal the transport reported', async () => {
    const control = new FakeControlSession('thread-1', 'provider', true);
    control.plan = { hang: true };
    const { agent } = agentFor(registration(control));
    const session = await agent.openSession();
    const handle = session.start('hello');

    await expect(handle.interrupt()).resolves.toEqual({ requested: true, terminal: 'interrupted' });
    await expect(handle.result).resolves.toMatchObject({ status: 'completed' });
  });

  it('round-trips an approval through TurnOptions.onInteraction', async () => {
    const control = new FakeControlSession('thread-1', 'provider', true);
    control.plan = { approval: true };
    const { agent } = agentFor(registration(control));
    const session = await agent.openSession();

    const seen: InteractionRequest[] = [];
    const turn = await session.send('run ls', {
      onInteraction: async (request) => {
        seen.push(request);
        return { kind: 'approval', decision: 'allow' };
      },
    });

    expect(seen[0]).toMatchObject({ kind: 'tool-approval', toolName: 'Bash' });
    expect(seen[0]?.binding.transportEpoch).toBe('epoch-1');
    expect(turn.events).toContainEqual({ type: 'tool.completed', id: 'tool-1', output: 'allow' });
  });

  it('round-trips an approval through TurnHandle.respond while the handler defers', async () => {
    const control = new FakeControlSession('thread-1', 'provider', true);
    control.plan = { approval: true };
    const { agent } = agentFor(registration(control));
    const session = await agent.openSession();

    let interactionId!: string;
    let markRequested!: () => void;
    const requested = new Promise<void>((resolve) => { markRequested = resolve; });
    const handle = session.start('run ls', {
      onInteraction: async (request) => {
        interactionId = request.binding.interactionId;
        markRequested();
        // The application answers out of band; this handler never resolves.
        return new Promise<never>(() => {});
      },
    });

    await requested;
    await handle.respond(interactionId, { kind: 'approval', decision: 'deny', reason: 'policy' });
    const turn = await handle.result;

    expect(turn.events).toContainEqual({ type: 'tool.completed', id: 'tool-1', output: 'deny' });
  });

  it('does not mark an interaction settled when the broker rejects the out-of-band response (R11)', async () => {
    const control = new FakeControlSession('thread-1', 'provider', true);
    control.plan = { approval: true };
    const { agent } = agentFor(registration(control));
    const session = await agent.openSession();

    let interactionId!: string;
    let answer!: (response: InteractionResponse) => void;
    let markRequested!: () => void;
    const requested = new Promise<void>((resolve) => { markRequested = resolve; });
    const handle = session.start('run ls', {
      onInteraction: (request) => {
        interactionId = request.binding.interactionId;
        markRequested();
        return new Promise<InteractionResponse>((resolve) => { answer = resolve; });
      },
    });

    await requested;
    // A decision the provider never advertised: the broker refuses it and the
    // interaction is still pending, so the handler's own answer must go through.
    await expect(handle.respond(interactionId, { kind: 'approval', decision: 'maybe' }))
      .rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    answer({ kind: 'approval', decision: 'allow' });
    const turn = await Promise.race([
      handle.result,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('turn hung: handler answer was dropped')), 2_000)),
    ]);

    expect(turn.events).toContainEqual({ type: 'tool.completed', id: 'tool-1', output: 'allow' });
  });

  it('settles the wire before surfacing the typed error when no handler is registered', async () => {
    const control = new FakeControlSession('thread-1', 'provider', true);
    control.plan = { approval: true };
    const { agent } = agentFor(registration(control));
    const session = await agent.openSession();

    await expect(session.send('run ls')).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(session.state).toBe('failed');
  });

  it('leaves a persisted session unknown when the transport dies mid-turn', async () => {
    const control = new FakeControlSession('thread-1', 'provider', true);
    control.plan = { hang: true };
    const { agent } = agentFor(registration(control));
    const session = await agent.openSession();
    const handle = session.start('hello');

    control.death();
    await expect(handle.result).rejects.toThrow(/transport died/);
    expect(session.state).toBe('unknown');
    await expect(session.send('again')).rejects.toBeInstanceOf(SessionInterruptedError);
    await expect(session.reconcile()).resolves.toBe('unknown');
  });

  it('fails an ephemeral session terminally when the transport dies mid-turn', async () => {
    const control = new FakeControlSession('thread-1', 'process', true);
    control.plan = { hang: true };
    const { agent } = agentFor(registration(control));
    const session = await agent.openSession({ persistence: 'process' });
    const handle = session.start('hello');

    control.death();
    await expect(handle.result).rejects.toThrow(/transport died/);
    expect(session.state).toBe('failed');
    await expect(session.reconcile()).resolves.toBe('failed');
  });

  it('forks a control session into a distinct child that runs its own first turn', async () => {
    const control = new FakeControlSession('thread-1', 'provider', true);
    const { agent } = agentFor(registration(control));
    const session = await agent.openSession();
    await session.send('hello');

    const fork = await session.forkAndSend('branch');

    expect(control.forks).toBe(1);
    expect(fork.session.ref?.id).toBe('thread-1-fork');
    expect(fork.turn.text).toBe('forked');
    expect(session.state).toBe('idle');
  });

  it('keeps the typed error when a control adapter registers without a session factory', async () => {
    const { agent } = agentFor(registration(undefined));

    await expect(agent.ready()).resolves.toMatchObject({ plan: { transport: 'control' } });
    await expect(agent.openSession()).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    await expect(agent.openSession())
      .rejects.toThrow(/claudeControlV1.*supplied no session factory/);
  });
});

describe('live turn events', () => {
  it('delivers an interaction before result settlement so the handle can answer it', async () => {
    const control=new FakeControlSession('live', 'provider', true);
    control.plan={approval:true};
    const {agent}=agentFor(registration(control));
    const session=await agent.openSession();
    const turn=session.start('ask',{timeoutMs:150,onInteraction:()=>new Promise(()=>{})});
    const iterator=turn.events[Symbol.asyncIterator]();
    const first=await iterator.next();
    expect(first.value).toMatchObject({type:'interaction.requested'});
    if (first.value?.type==='interaction.requested') await turn.respond(first.value.request.binding.interactionId,{kind:'approval',decision:'allow'});
    await expect(turn.result).resolves.toMatchObject({status:'completed'});
  });
});

describe('live native fork', () => {
  it('returns a confirmed child while its first turn is still running with live interactions', async () => {
    const parent=new FakeControlSession('parent','provider',true);
    const child=new FakeControlSession('child','provider',true);child.plan={approval:true};
    parent.fork=async()=>child;
    const {agent}=agentFor(registration(parent));const session=await agent.openSession();
    const fork=await session.startFork('branch',{timeoutMs:250,onInteraction:()=>new Promise(()=>{})});
    expect(fork.session.export().id).toBe('child');
    const event=await fork.turn.events[Symbol.asyncIterator]().next();
    expect(event.value).toMatchObject({type:'interaction.requested'});
    if(event.value?.type==='interaction.requested') await fork.turn.respond(event.value.request.binding.interactionId,{kind:'approval',decision:'allow'});
    await expect(fork.turn.result).resolves.toMatchObject({status:'completed'});
    expect(session.state).toBe('idle');
  });
  it('closes a child confirmed after the fork operation was aborted', async () => {
    const parent=new FakeControlSession('parent','provider',true);const child=new FakeControlSession('late','provider',true);
    let resolve!:()=>void;parent.fork=async()=>{await new Promise<void>((done)=>{resolve=done;});return child;};
    const {agent}=agentFor(registration(parent));const session=await agent.openSession();
    await expect(session.startFork('branch',{timeoutMs:20})).rejects.toMatchObject({code:'TIMEOUT'});
    resolve();await new Promise((done)=>setTimeout(done,5));
    expect(child.closed).toBe(true);expect(session.state).toBe('idle');
  });
});

  it('does not fail result-only consumers when their live event queue overflows', async () => {
    const control=new FakeControlSession('many','provider',true);
    control.plan={events:Array.from({length:5000},()=>({type:'message.delta' as const,text:'x'}))};
    // The fixture's transport queue is intentionally larger than the public observer buffer.
    const {agent}=agentFor(registration(control));
    const session=await agent.openSession();
    await expect(session.send('many')).resolves.toMatchObject({status:'completed'});
  });
