import { realpath } from "node:fs/promises";
import type { AdapterStreamItem, ExecAdapter, ExecProbeContext, ProcessRunner, ProtocolResult, ExecTurnRequest } from "../../adapters/provider.js";
import type { ModelInfo } from "../../public/types.js";
import type { LaunchTarget } from "../../process/resolve-binary.js";
import { AbortError, OutputLimitError, ProtocolError, ProviderUnavailableError, UnsupportedCliVersionError } from "../../public/errors.js";
import {
  ExecDiscovery,
  IncrementalLineDecoder,
  runProcess,
} from "../../public/adapter-kit.js";
import { inspectAntigravityAuth } from "./auth.js";
import { buildAntigravityArgs } from "./argv.js";
import {
  assessAntigravityCompatibility,
  isTestedAntigravityCliVersion,
} from "./compatibility.js";
import { AntigravityProtocol } from "./protocol.js";
import { StreamQueue } from "./streaming.js";
export class AntigravityExecAdapter implements ExecAdapter {
  readonly id = "antigravity";
  readonly #runner: ProcessRunner;
  readonly #discovery: ExecDiscovery;
  readonly #catalog: readonly ModelInfo[];
  constructor(
    options: {
      runner?: ProcessRunner;
      target?: LaunchTarget;
      modelCatalog?: readonly ModelInfo[];
    } = {},
  ) {
    this.#runner = options.runner ?? runProcess;
    const target = options.target
      ? {
          command: options.target.command,
          argsPrefix: [...options.target.argsPrefix],
        }
      : undefined;
    this.#discovery = new ExecDiscovery("agy", this.#runner, target);
    this.#catalog = (options.modelCatalog ?? []).map((model) => ({
      ...model,
      aliases: [...model.aliases],
    }));
  }
  detect(env: NodeJS.ProcessEnv, context?: ExecProbeContext) {
    return this.#discovery.detect(env, context);
  }
  auth(env: NodeJS.ProcessEnv) {
    return inspectAntigravityAuth(env);
  }
  async models(): Promise<ModelInfo[]> {
    return this.#catalog.map((model) => ({
      ...model,
      aliases: [...model.aliases],
    }));
  }
  async compatibility(env: NodeJS.ProcessEnv, version: string, context?: ExecProbeContext) {
    if (context?.signal.aborted) throw context.signal.reason;
    const target = this.#discovery.target(env);
    if (!target) return undefined;
    const result = await this.#runner({
      command: target.command,
      args: [...target.argsPrefix, "--help"],
      cwd: process.cwd(),
      env,
      stdin: "",
      timeoutMs: Math.max(1, Math.min(15000, context?.remainingMs() ?? 15000)),
      ...(context ? { signal: context.signal } : {}),
      maxOutputBytes: 256 * 1024,
    });
    return assessAntigravityCompatibility(
      version,
      result.code === 0 ? `${result.stdout}\n${result.stderr}` : "",
    );
  }
  async execute(request: ExecTurnRequest): Promise<ProtocolResult> {
    let result: ProtocolResult | undefined;
    for await (const item of this.stream(request))
      if (item.kind === "result") result = item.result;
    if (!result)
      throw new ProviderUnavailableError(
        { provider: "antigravity", retryable: false },
        "Antigravity returned no result",
      );
    return result;
  }
  async *stream(request: ExecTurnRequest): AsyncIterable<AdapterStreamItem> {
    if (request.signal?.aborted)
      throw new AbortError({ provider: "antigravity", retryable: true });
    const args = buildAntigravityArgs(request);
    const expires = performance.now() + request.timeoutMs;
    const context: ExecProbeContext = { signal: request.signal ?? AbortSignal.timeout(request.timeoutMs),
      deadline: Date.now() + request.timeoutMs, remainingMs: () => Math.max(0, Math.floor(expires - performance.now())) };
    const installation = await this.detect(request.env, context),
      target = this.#discovery.target(request.env);
    if (!installation.installed || !target)
      throw new ProviderUnavailableError(
        { provider: "antigravity", retryable: false },
        "Antigravity CLI unavailable",
      );
    const version = installation.version;
    if (!isTestedAntigravityCliVersion(version))
      throw new UnsupportedCliVersionError(
        "antigravity",
        version ?? "unknown",
        { provider: "antigravity", retryable: false },
      );
    const compatibility = await this.compatibility(
      request.env,
      version,
      context,
    );
    if (!compatibility || compatibility.missingFlags.length)
      throw new UnsupportedCliVersionError("antigravity", version, {
        provider: "antigravity",
        retryable: false,
      });
    const cwd = await realpath(request.cwd);
    if (request.signal?.aborted)
      throw new AbortError({ provider: "antigravity", retryable: true });
    const abort = new AbortController(),
      signal = request.signal
        ? AbortSignal.any([request.signal, abort.signal])
        : abort.signal;
    const queue = new StreamQueue<AdapterStreamItem>();
    const protocol = new AntigravityProtocol(
      request.mode === "resume" ? request.sessionId : undefined,
      { model: request.modelId, cwd },
    );
    const decoder = new IncrementalLineDecoder({
      maxBufferedBytes: Math.min(request.maxOutputBytes, 1024 * 1024),
    });
    const utf8 = new TextDecoder("utf-8", { fatal: true });
    let announced: string | undefined,
      observed = false,
      stdoutBytes = 0;
    const line = (raw: string) => {
      const events = protocol.line(raw);
      if (protocol.fatalProtocolFailure) {
        // runProcess treats a throwing stdout consumer as terminal and awaits
        // process-group cleanup before rejecting. Do not leave a rejected
        // native permission or identity configuration running until timeout.
        throw new ProtocolError(
          { provider: "antigravity", transport: "exec", retryable: false },
          "Antigravity emitted an invalid native protocol frame",
        );
      }
      if (protocol.sessionId && protocol.sessionId !== announced) {
        announced = protocol.sessionId;
        queue.push({ kind: "session", sessionId: announced });
      }
      for (const event of events) queue.push({ kind: "event", event });
    };
    const chunk = (value: Uint8Array) => {
      stdoutBytes += value.byteLength;
      if (stdoutBytes > request.maxOutputBytes)
        throw new OutputLimitError({
          provider: "antigravity",
          retryable: false,
        });
      utf8.decode(value, { stream: true });
      for (const raw of decoder.push(value)) line(raw);
    };
    const execution = Promise.resolve()
      .then(() =>
        this.#runner({
          command: target.command,
          args: [...target.argsPrefix, ...args],
          cwd,
          env: request.env,
          stdin: "",
          timeoutMs: request.timeoutMs,
          maxOutputBytes: request.maxOutputBytes,
          signal,
          onStdout: (value) => {
            observed = true;
            chunk(value);
          },
        }),
      )
      .then((outcome) => {
        if (!observed && outcome.stdout) chunk(Buffer.from(outcome.stdout));
        utf8.decode();
        for (const raw of decoder.finish()) line(raw);
        let result = protocol.finish(outcome.code);
        if (
          result.failure?.kind === "protocol" &&
          result.nativeEvents.length === 0 &&
          outcome.stdout.trim() === "" &&
          outcome.code !== 0
        ) {
          const exit = outcome.code === null ? "null" : String(outcome.code);
          // Only stable native auth signatures are classified. Provider stderr
          // remains bounded and is never copied into public diagnostics.
          const authenticationRequired =
            /(?:^|\r?\n)(?:error:\s*)?(?:authentication required|UNAUTHENTICATED|LOGIN_REQUIRED)(?:[ \t]*(?:[.!:]|\r?\n|$))/i.test(
              outcome.stderr.slice(0, 8192),
            );
          result = {
            ...result,
            failure: {
              kind: authenticationRequired
                ? "not-authenticated"
                : "provider-unavailable",
              rawCode: authenticationRequired
                ? "AUTHENTICATION_REQUIRED"
                : `EXIT_${exit}`,
              message: `Antigravity ended before NDJSON initialization (exit=${exit}; stderrBytes=${Buffer.byteLength(outcome.stderr, "utf8")})`,
            },
          };
        }
        for (const event of result.events)
          if (event.type === "message.completed")
            queue.push({ kind: "event", event });
        queue.push({ kind: "result", result });
        queue.close();
      })
      .catch((error) => queue.close(error));
    try {
      yield* queue;
    } finally {
      abort.abort();
      await execution;
    }
  }
}
