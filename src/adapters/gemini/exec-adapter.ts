import { realpath } from "node:fs/promises";
import type { AdapterStreamItem, ExecAdapter, ExecProbeContext, ExecTurnRequest, ProcessRunner, ProtocolResult } from "../../adapters/provider.js";
import type { LaunchTarget } from "../../process/resolve-binary.js";
import type { ModelInfo } from "../../public/types.js";
import { AbortError, ProviderUnavailableError, UnsupportedCliVersionError } from "../../public/errors.js";
import {
  ExecDiscovery,
  IncrementalLineDecoder,
  runProcess,
} from "../../public/adapter-kit.js";
import { inspectGeminiAuth } from "./auth.js";
import { buildGeminiArgs } from "./argv.js";
import { assessGeminiCompatibility, GEMINI_VERSION } from "./compatibility.js";
import { prepareAnalyzeEnvelope } from "./envelope.js";
import { GeminiProtocol } from "./protocol.js";
import { StreamQueue } from "./streaming.js";

export interface GeminiExecAdapterOptions {
  runner?: ProcessRunner;
  probeRunner?: ProcessRunner;
  target?: LaunchTarget;
  modelCatalog?: readonly ModelInfo[];
}
export class GeminiExecAdapter implements ExecAdapter {
  readonly id = "gemini";
  readonly #runner: ProcessRunner;
  readonly #probeRunner: ProcessRunner;
  readonly #discovery: ExecDiscovery;
  readonly #catalog: readonly ModelInfo[];
  constructor(options: GeminiExecAdapterOptions = {}) {
    this.#runner = options.runner ?? runProcess;
    this.#probeRunner = options.probeRunner ?? this.#runner;
    const target = options.target
      ? {
          command: options.target.command,
          argsPrefix: [...options.target.argsPrefix],
        }
      : undefined;
    this.#discovery = new ExecDiscovery("gemini", this.#probeRunner, target);
    this.#catalog = (options.modelCatalog ?? []).map((model) => ({
      ...model,
      aliases: [...model.aliases],
    }));
  }
  detect(env: NodeJS.ProcessEnv, context?: ExecProbeContext) {
    return this.#discovery.detect(env, context);
  }
  auth(env: NodeJS.ProcessEnv) {
    return inspectGeminiAuth(env);
  }
  async models(): Promise<ModelInfo[]> {
    return this.#catalog.map((m) => ({ ...m, aliases: [...m.aliases] }));
  }
  async compatibility(env: NodeJS.ProcessEnv, version: string, context?: ExecProbeContext) {
    if (context?.signal.aborted) throw context.signal.reason;
    const target = this.#discovery.target(env);
    if (!target) return undefined;
    const result = await this.#probeRunner({
      command: target.command,
      args: [...target.argsPrefix, "--help"],
      cwd: process.cwd(),
      env,
      stdin: "",
      timeoutMs: Math.max(1, Math.min(15000, context?.remainingMs() ?? 15000)),
      ...(context ? { signal: context.signal } : {}),
      maxOutputBytes: 256 * 1024,
    });
    return assessGeminiCompatibility(
      version,
      result.code === 0 ? result.stdout : "",
    );
  }
  async execute(request: ExecTurnRequest): Promise<ProtocolResult> {
    let result: ProtocolResult | undefined;
    for await (const item of this.stream(request))
      if (item.kind === "result") result = item.result;
    if (!result)
      throw new ProviderUnavailableError(
        { provider: "gemini", retryable: false },
        "Gemini stream returned no result",
      );
    return result;
  }
  async *stream(request: ExecTurnRequest): AsyncIterable<AdapterStreamItem> {
    if (request.signal?.aborted)
      throw new AbortError({ provider: "gemini", retryable: true });
    const args = buildGeminiArgs(request);
    if (request.providerOptions && Object.keys(request.providerOptions).length)
      throw new TypeError("Gemini provider options are not supported");
    const expires = performance.now() + request.timeoutMs;
    const context: ExecProbeContext = { signal: request.signal ?? AbortSignal.timeout(request.timeoutMs),
      deadline: Date.now() + request.timeoutMs, remainingMs: () => Math.max(0, Math.floor(expires - performance.now())) };
    const installation = await this.detect(request.env, context),
      target = this.#discovery.target(request.env);
    if (!installation.installed || !target)
      throw new ProviderUnavailableError(
        { provider: "gemini", retryable: false },
        "Gemini CLI unavailable",
      );
    if (installation.version !== GEMINI_VERSION)
      throw new UnsupportedCliVersionError(
        "gemini",
        installation.version ?? "unknown",
        { provider: "gemini", retryable: false },
      );
    const compatibility = await this.compatibility(request.env, GEMINI_VERSION, context);
    if (!compatibility || compatibility.missingFlags.length)
      throw new UnsupportedCliVersionError("gemini", GEMINI_VERSION, {
        provider: "gemini",
        retryable: false,
      });
    const cwd = await realpath(request.cwd);
    const envelope = await prepareAnalyzeEnvelope(request.env, cwd);
    const abort = new AbortController();
    const signal = request.signal
      ? AbortSignal.any([request.signal, abort.signal])
      : abort.signal;
    const queue = new StreamQueue<AdapterStreamItem>();
    const protocol = new GeminiProtocol(
      request.mode === "resume" ? request.sessionId : undefined,
    );
    const decoder = new IncrementalLineDecoder({
      maxBufferedBytes: Math.min(request.maxOutputBytes, 1024 * 1024),
    });
    let announced: string | undefined,
      observed = false;
    const line = (raw: string) => {
      const events = protocol.line(raw);
      if (protocol.sessionId && protocol.sessionId !== announced) {
        announced = protocol.sessionId;
        queue.push({ kind: "session", sessionId: announced });
      }
      for (const event of events) queue.push({ kind: "event", event });
    };
    const execution = Promise.resolve()
      .then(() =>
        this.#runner({
          command: target.command,
          args: [...target.argsPrefix, ...args, ...envelope.args],
          cwd,
          env: envelope.env,
          stdin: "",
          timeoutMs: request.timeoutMs,
          maxOutputBytes: request.maxOutputBytes,
          signal,
          onStdout: (chunk) => {
            observed = true;
            for (const raw of decoder.push(chunk)) line(raw);
          },
        }),
      )
      .then((outcome) => {
        if (!observed && outcome.stdout)
          for (const raw of decoder.push(Buffer.from(outcome.stdout)))
            line(raw);
        for (const raw of decoder.finish()) line(raw);
        let result = protocol.finish(outcome.code);
        if (
          result.failure &&
          result.nativeEvents.length === 0 &&
          outcome.stdout.trim() === ""
        ) {
          if (
            outcome.code !== 0 &&
            result.failure.kind !== "not-authenticated" &&
            /["']?reasonCode["']?\s*:\s*["']UNSUPPORTED_CLIENT["']/.test(
              outcome.stderr,
            )
          )
            throw new UnsupportedCliVersionError("gemini", GEMINI_VERSION, {
              provider: "gemini",
              transport: "exec",
              rawCode: "UNSUPPORTED_CLIENT",
              retryable: false,
            });
          const exit = outcome.code === null ? "null" : String(outcome.code);
          const signal =
            outcome.signal && /^[A-Z0-9]+$/.test(outcome.signal)
              ? outcome.signal
              : "none";
          const stderrBytes = Buffer.byteLength(outcome.stderr, "utf8");
          result = {
            ...result,
            failure: {
              kind:
                result.failure.kind === "protocol" && outcome.code !== 0
                  ? outcome.code === 55
                    ? "untrusted-workspace"
                    : "provider-unavailable"
                  : result.failure.kind,
              message: `Gemini process ended before JSONL initialization (exit=${exit}; signal=${signal}; stderrBytes=${stderrBytes})`,
              rawCode: result.failure.rawCode ?? `EXIT_${exit}`,
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
      await envelope.cleanup();
    }
  }
}
