import type { PayloadReference } from './types.js';
import { artifactFailure, artifactInputSize, artifactIoOptions, artifactOptions, artifactReference, captureArtifactInput, checkArtifactAbort } from './artifacts-validation.js';
import { createArtifactFiles, publishArtifact, scanArtifact } from './artifacts-files.js';
import { LogArtifactError, type LogArtifactOptions, type LogArtifactReadOptions, type LogArtifactWriteOptions, type LogArtifactVerification } from './artifacts-types.js';
export type { LogArtifactOptions, LogArtifactReadOptions, LogArtifactWriteOptions, LogArtifactVerification, LogArtifactBinding } from './artifacts-types.js';
export { LogArtifactError } from './artifacts-types.js';
const observed = <T>(promise: Promise<T>) => { void promise.catch(() => {}); return promise; };
/** Optional private artifact storage. Refs/pins are DATA; the execution log owns its transactional reference records. No GC or permission API. */
export async function createLogArtifactStore(input: LogArtifactOptions) {
  const options = artifactOptions(input); let files: Awaited<ReturnType<typeof createArtifactFiles>>;
  try { files = await createArtifactFiles(options.directory, options.binding); } catch (cause) { throw artifactFailure(cause); }
  let pending = 0;
  const reserve = () => { files.check(); if (pending >= options.maxPending) throw new LogArtifactError('BUSY'); pending++; };
  const run = <T>(work: () => Promise<T>): Promise<T> => observed((async () => {
    try { return await work(); } catch (cause) { throw artifactFailure(cause); } finally { pending--; }
  })());
  return Object.freeze({
    write(input: string | Uint8Array, operation: LogArtifactWriteOptions): Promise<PayloadReference> {
      let owned: string | Buffer;
      try { const io = artifactIoOptions(operation, true), length = artifactInputSize(input, options.maxBytes); checkArtifactAbort(io.signal); reserve();
        try { owned = captureArtifactInput(input, length); } catch (error) { pending--; throw error; }
        return run(async () => { try { return await publishArtifact(files, options.binding, owned, length, io.mediaType!, io.signal); } finally { if (typeof owned !== 'string') owned.fill(0); } });
      } catch (cause) { return observed(Promise.reject(artifactFailure(cause))); }
    },
    verify(input: PayloadReference, operation: LogArtifactReadOptions = {}): Promise<LogArtifactVerification> {
      let reference: PayloadReference;
      try { reference = artifactReference(input, options.binding, options.maxBytes); const io = artifactIoOptions(operation); checkArtifactAbort(io.signal);
        try { reserve(); } catch (cause) { if (cause instanceof LogArtifactError && cause.code === 'CORRUPT') return Promise.resolve(Object.freeze({ kind: 'corrupt', reference })); throw cause; }
        return run(async () => { try { await scanArtifact(files, reference, io.signal); return Object.freeze({ kind: 'verified', reference }); }
          catch (cause) { if (cause instanceof LogArtifactError && (cause.code === 'MISSING' || cause.code === 'CORRUPT')) return Object.freeze({ kind: cause.code === 'MISSING' ? 'missing' : 'corrupt', reference }); throw cause; } });
      } catch (cause) { return observed(Promise.reject(artifactFailure(cause))); }
    },
    read(input: PayloadReference, operation: LogArtifactReadOptions = {}): Promise<Uint8Array> {
      try { const reference = artifactReference(input, options.binding, options.maxBytes), io = artifactIoOptions(operation); checkArtifactAbort(io.signal); reserve();
        return run(async () => (await scanArtifact(files, reference, io.signal, true))!);
      } catch (cause) { return observed(Promise.reject(artifactFailure(cause))); }
    },
    snapshot: () => Object.freeze({ pending, maxPending: options.maxPending, maxBytes: options.maxBytes, ...files.snapshot() }),
  });
}
