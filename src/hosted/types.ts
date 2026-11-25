import type { AdmissionRefusalReason } from '../public/errors.js';
import type { ProviderRegistration } from '../core/provider-registration.js';
import type { CapabilitySupport, ModelInfo } from '../public/types.js';
import type { ProcessRunner } from '../adapters/provider.js';
export type HostedJson = null | boolean | number | string | HostedJson[] | {
    [key: string]: HostedJson;
};
export interface HostedRecipeDescriptor {
    readonly recipeId: string;
    readonly recipeDigest: string;
    readonly contextArgs: readonly string[];
    readonly permissionArgs: readonly string[];
    readonly providerOptionsDigest: string;
    readonly clientEnvironmentPolicyDigest: string;
    readonly environmentPolicyId: string;
    readonly modelIds: readonly string[];
    readonly efforts: readonly string[];
    readonly allowInstructions: boolean;
    readonly cwdRoots: readonly string[];
}
export interface HostedProviderDescriptor {
    readonly schemaVersion: 1;
    readonly provider: string;
    readonly bindingId: string;
    readonly bindingDigest: string;
    readonly token: string;
    readonly adapterVersion: string;
    readonly modelCatalog: readonly ModelInfo[];
    readonly execCapabilities: Readonly<Record<string, CapabilitySupport>>;
    readonly target: Readonly<{
        command: string;
        argsPrefix: readonly string[];
        executableDigest: string;
        identityFiles: readonly string[];
    }>;
    readonly probeRecipeId: string;
    readonly limits: Readonly<{
        maxTurnMs: number;
        maxProbeMs: number;
        maxOutputBytes: number;
    }>;
    readonly recipes: readonly HostedRecipeDescriptor[];
}
export interface HostedTurnPayload {
    readonly mode: 'open' | 'resume' | 'fork' | 'one-shot';
    readonly modelId: string;
    readonly cwd: string;
    readonly prompt: string;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly sessionId?: string;
    readonly instructions?: string;
    readonly effort?: string;
    readonly outputSchema?: {
        [key: string]: HostedJson;
    };
    readonly intentId?: string;
    /**
     * A request to wait behind every default turn for the host's admission. The only value is `low`:
     * a worker may lower a turn (a rehearsal), never raise one. Absent means the default priority.
     */
    readonly priority?: 'low';
}
interface RequestBase {
    readonly schemaVersion: 1;
    readonly channelId: string;
    readonly systemId: string;
    readonly generation: number;
    readonly bindingId: string;
    readonly requestId: string;
    readonly remainingMs: number;
}
export type HostedRequest = RequestBase & ({
    readonly method: 'detect' | 'auth' | 'models' | 'compatibility';
    readonly recipeId: string;
    readonly cwd: string;
} | {
    readonly method: 'execute' | 'stream-open';
    readonly recipeId: string;
    readonly turn: HostedTurnPayload;
} | {
    readonly method: 'stream-next' | 'stream-return' | 'stream-throw' | 'status';
    readonly operationId: string;
} | {
    readonly method: 'cancel';
    readonly targetRequestId: string;
} | {
    readonly method: 'intent-begin';
    readonly turnId: string;
    readonly semanticDigest: string;
} | {
    readonly method: 'intent-finish';
    readonly intentId: string;
});
export type HostedErrorCode = 'ADMISSION_REFUSED' | 'EXECUTION_HALTED' | 'USAGE_LIMIT' | 'UNSUPPORTED_CAPABILITY' | 'INVALID_RUNTIME_PROTOCOL' | 'ABORTED' | 'TIMEOUT' | 'OUTPUT_LIMIT' | 'PROVIDER_UNAVAILABLE' | 'NOT_AUTHENTICATED';
export type HostedErrorWire = Readonly<{
    code: 'ADMISSION_REFUSED';
    reason: AdmissionRefusalReason;
    receiptDigest: string;
}> | Readonly<{
    code: Exclude<HostedErrorCode, 'ADMISSION_REFUSED'>;
    receiptDigest?: string;
}>;
export type HostedReply = Omit<RequestBase, 'remainingMs'> & ({
    readonly ok: true;
    readonly data: HostedJson;
} | {
    readonly ok: false;
    readonly error: HostedErrorWire;
});
/** Trusted local transport facade built by Root bootstrap. It is never serialized or host authority. */
export interface HostedRuntimeClient {
    call(request: HostedRequest, options?: {
        readonly signal?: AbortSignal;
        readonly remainingMs?: number;
    }): Promise<HostedReply>;
    close(): void;
}
export interface HostedWorkerContext {
    readonly schemaVersion: 1;
    readonly channelId: string;
    readonly systemId: string;
    readonly generation: number;
    readonly dataDirectory: string;
    readonly descriptors: readonly HostedProviderDescriptor[];
    readonly client: HostedRuntimeClient;
}
/** Trusted fingerprinted worker code only, never a factory/module name supplied over RPC. */
export interface HostedProxyFactory {
    readonly id: string;
    create(options: {
        runner: ProcessRunner;
        probeRunner: ProcessRunner;
    }): ProviderRegistration;
}
