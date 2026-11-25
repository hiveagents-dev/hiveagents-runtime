import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { AdmissionRefusedError, AbortError, TimeoutError, UsageLimitError, OutputLimitError, UnsupportedCapabilityError, ProviderUnavailableError, NotAuthenticatedError } from '../public/errors.js';
import { hostedHalt, HOSTED_BOUNDS, invalid } from './json.js';
import { captureHostedReply, captureHostedRequest } from './validation.js';
import type { HostedRequest, HostedWorkerContext } from './types.js';
/** Capture a trusted local method without invoking accessors, including prototype methods. */
export function method(value: unknown, key: string): (...args: any[]) => any {
    if (!value || typeof value !== 'object' || types.isProxy(value))
        invalid();
    let current: object | null = value;
    for (let depth = 0; current && depth < 8; depth++, current = Object.getPrototypeOf(current)) {
        if (types.isProxy(current))
            invalid();
        const d = Object.getOwnPropertyDescriptor(current, key);
        if (d) {
            if (!Object.hasOwn(d, 'value') || typeof d.value !== 'function')
                invalid();
            return d.value.bind(value);
        }
    }
    return invalid();
}
export type HostedBody = HostedRequest extends infer R ? R extends HostedRequest ? Omit<R, 'schemaVersion' | 'channelId' | 'systemId' | 'generation' | 'bindingId' | 'requestId' | 'remainingMs'> : never : never;
export function createHostedCaller(context: HostedWorkerContext) {
    const call = method(context.client, 'call'), close = method(context.client, 'close');
    let pending = 0, closed = false;
    const stop = (cause?: unknown): never => {
        if (!closed) {
            closed = true;
            try {
                close();
            }
            catch { }
        }
        throw hostedHalt('HOSTED_CHANNEL_UNKNOWN', cause);
    };
    return async (bindingId: string, body: HostedBody, remainingMs: number, signal?: AbortSignal): Promise<unknown> => {
        if (closed)
            throw hostedHalt('HOSTED_CHANNEL_CLOSED');
        if (signal?.aborted)
            throw signal.reason ?? new AbortError({ retryable: false });
        if (pending >= HOSTED_BOUNDS.pending)
            throw hostedHalt('HOSTED_PENDING_LIMIT');
        const request = captureHostedRequest({ schemaVersion: 1, channelId: context.channelId, systemId: context.systemId, generation: context.generation, bindingId, requestId: randomUUID(), remainingMs, ...body });
        pending++;
        let reply;
        try {
            const work = call(request, { remainingMs, ...(signal === undefined ? {} : { signal }) });
            if (!types.isPromise(work) || Object.getPrototypeOf(work) !== Promise.prototype || Object.hasOwn(work, 'constructor') || Object.hasOwn(work, 'then'))
                stop();
            reply = captureHostedReply(await work);
            for (const key of ['channelId', 'systemId', 'generation', 'bindingId', 'requestId'] as const)
                if (reply[key] !== request[key])
                    stop();
        }
        catch (error) {
            return stop(error);
        }
        finally {
            pending--;
        }
        if (reply.ok)
            return reply.data;
        const code = reply.error.code;
        if (code === 'EXECUTION_HALTED' || code === 'INVALID_RUNTIME_PROTOCOL')
            throw hostedHalt(code);
        const provider = context.descriptors.find(d => d.bindingId === bindingId)?.provider;
        if (!provider)
            invalid();
        const errorContext = { provider, transport: 'exec' as const, retryable: false, ...(reply.error.receiptDigest === undefined ? {} : { sanitizedDiagnostics: { receiptDigest: reply.error.receiptDigest } }) };
        if (reply.error.code === 'ADMISSION_REFUSED')
            throw new AdmissionRefusedError(provider, { reason: reply.error.reason, receiptDigest: reply.error.receiptDigest });
        const constructors = { USAGE_LIMIT: UsageLimitError, ABORTED: AbortError, TIMEOUT: TimeoutError, OUTPUT_LIMIT: OutputLimitError, UNSUPPORTED_CAPABILITY: UnsupportedCapabilityError, PROVIDER_UNAVAILABLE: ProviderUnavailableError };
        if (code === 'NOT_AUTHENTICATED')
            throw new NotAuthenticatedError(provider, errorContext);
        throw new constructors[code as keyof typeof constructors](errorContext);
    };
}
