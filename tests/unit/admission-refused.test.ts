import { describe, expect, it } from 'vitest';
import * as errors from '../../src/public/errors.js';
const Constructor = () => (errors as unknown as {
    AdmissionRefusedError: new (provider: string, input: {
        reason: string;
        receiptDigest: string;
    }) => Error & {
        code: string;
        reason: string;
        receiptDigest: string;
        provider: string;
        context: {
            retryable: boolean;
        };
    };
}).AdmissionRefusedError;
describe('nominal admission refusal data (never fallback authority)', () => {
    it('captures the finite reason/receipt/provider without treating it as a usage limit', () => { const ErrorType = Constructor(); expect(typeof ErrorType).toBe('function'); const input = { reason: 'concurrency-limit', receiptDigest: 'a'.repeat(64) }, error = new ErrorType('claude', input); input.reason = 'quota-cooldown'; expect(error).toBeInstanceOf(errors.AgentRuntimeError); expect(error).not.toBeInstanceOf(errors.UsageLimitError); expect(error.code).toBe('ADMISSION_REFUSED'); expect(error.reason).toBe('concurrency-limit'); expect(error.receiptDigest).toBe('a'.repeat(64)); expect(error.provider).toBe('claude'); expect(error.context.retryable).toBe(false); });
    it('rejects non-definitive reasons, malformed digests and accessors without executing them', () => { const ErrorType = Constructor(); let calls = 0; for (const reason of ['storage-unavailable', 'unknown', 'closed'])
        expect(() => new ErrorType('claude', { reason, receiptDigest: 'a'.repeat(64) })).toThrow(); expect(() => new ErrorType('claude', { reason: 'daily-limit', receiptDigest: 'bad' })).toThrow(); expect(() => new ErrorType('claude', Object.defineProperty({ receiptDigest: 'a'.repeat(64) }, 'reason', { get() { calls++; return 'daily-limit'; }, enumerable: true }) as never)).toThrow(); expect(calls).toBe(0); });
});
