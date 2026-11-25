import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CodexRpcPeer } from '../../src/adapters/codex-control/rpc-peer.js';
import {
  PINNED_CODEX_CLI_VERSION,
  serverRequestMethods,
  validateEnvelope,
  validateServerRequestFrame,
} from '../../src/adapters/codex-control/schemas.js';
import { ProtocolError } from '../../src/public/errors.js';

const schemasDir = fileURLToPath(new URL('../../src/adapters/codex-control/schemas/', import.meta.url));

interface ProvenanceFile {
  path: string;
  bytes: number;
  sha256: string;
}

interface Provenance {
  cliVersion: string;
  files: ProvenanceFile[];
}

describe('pinned Codex schemas provenance', () => {
  const provenance = JSON.parse(readFileSync(`${schemasDir}PROVENANCE.json`, 'utf8')) as Provenance;

  it('records the CLI version the module claims', () => {
    expect(provenance.cliVersion).toBe(PINNED_CODEX_CLI_VERSION);
  });

  it('covers every pinned schema file exactly once', () => {
    const pinned = readdirSync(schemasDir).filter((name) => name.endsWith('.json') && name !== 'PROVENANCE.json');
    expect(provenance.files.map(({ path }) => path).sort()).toEqual(pinned.sort());
  });

  it('matches the recorded sha256 and byte size of every pinned schema file', () => {
    for (const file of provenance.files) {
      const content = readFileSync(`${schemasDir}${file.path}`);
      expect({ path: file.path, bytes: content.byteLength }).toEqual({ path: file.path, bytes: file.bytes });
      expect({ path: file.path, sha256: createHash('sha256').update(content).digest('hex') })
        .toEqual({ path: file.path, sha256: file.sha256 });
    }
  });
});

describe('pinned Codex schema validators', () => {
  it('allowlists the security-critical server request methods', () => {
    const stable = serverRequestMethods('stable');
    for (const method of [
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
      'item/tool/requestUserInput',
      'mcpServer/elicitation/request',
      'item/tool/call',
    ]) {
      expect(stable.has(method)).toBe(true);
    }
    expect(stable.has('turn/start')).toBe(false);
    expect(serverRequestMethods('experimental').has('currentTime/read')).toBe(true);
    expect(stable.has('currentTime/read')).toBe(false);
  });

  it('accepts valid frames and rejects malformed approval params', () => {
    const valid = {
      id: 1,
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'item-1', startedAtMs: 1, threadId: 'thread-1', turnId: 'turn-1' },
    };
    expect(validateServerRequestFrame(valid, 'stable').valid).toBe(true);
    const tampered = { ...valid, params: { itemId: 'item-1' } };
    const result = validateServerRequestFrame(tampered, 'stable');
    expect(result.valid).toBe(false);
    expect(result.errors?.length).toBeGreaterThan(0);
  });

  it('validates the JSON-RPC envelope', () => {
    expect(validateEnvelope({ method: 'thread/item/agentMessage/delta', params: {} }).valid).toBe(true);
    expect(validateEnvelope({ id: 'c:e:1', result: {} }).valid).toBe(true);
    expect(validateEnvelope({ noise: true }).valid).toBe(false);
  });
});

describe('CodexRpcPeer runtime validation', () => {
  function makePeer(options?: { experimentalApi?: boolean }) {
    const writes: Array<Record<string, unknown>> = [];
    const handled: Array<{ method: string; params: unknown }> = [];
    const notifications: Array<{ method: string; params: unknown }> = [];
    const peer = new CodexRpcPeer({
      epoch: 'epoch-1',
      write: async (message) => { writes.push(message); },
      onServerRequest: async (method, params) => {
        handled.push({ method, params });
        return { decision: 'accept' };
      },
      onNotification: (method, params) => { notifications.push({ method, params }); },
      ...(options?.experimentalApi === undefined ? {} : { experimentalApi: options.experimentalApi }),
    });
    return { peer, writes, handled, notifications };
  }

  it('fails closed on a tampered security-critical server request without invoking the handler', async () => {
    const { peer, writes, handled } = makePeer();

    await expect(peer.receive({
      id: 'srv-1',
      method: 'item/commandExecution/requestApproval',
      params: { command: ['rm', '-rf', '/'] },
    })).rejects.toBeInstanceOf(ProtocolError);

    expect(handled).toEqual([]);
    expect(writes).toEqual([{
      id: 'srv-1',
      error: { code: -32602, message: 'Server request failed pinned schema validation' },
    }]);
  });

  it('refuses a non-allowlisted server request with an error response instead of crashing', async () => {
    const { peer, writes, handled } = makePeer();

    await peer.receive({ id: 'srv-2', method: 'account/secrets/read', params: {} });

    expect(handled).toEqual([]);
    expect(writes).toEqual([{
      id: 'srv-2',
      error: { code: -32601, message: 'Server request method is not allowlisted: account/secrets/read' },
    }]);
  });

  it('rejects an experimental-only server request unless the experimental API was negotiated', async () => {
    const params = { threadId: 'thread-1' };
    const stable = makePeer();
    await stable.peer.receive({ id: 1, method: 'currentTime/read', params });
    expect(stable.handled).toEqual([]);
    expect(stable.writes[0]?.error).toMatchObject({ code: -32601 });

    const experimental = makePeer({ experimentalApi: true });
    await experimental.peer.receive({ id: 1, method: 'currentTime/read', params });
    expect(experimental.handled).toEqual([{ method: 'currentTime/read', params }]);
  });

  it('preserves unknown non-critical notifications instead of dropping them', async () => {
    const { peer, writes, notifications } = makePeer();
    const params = { threadId: 'thread-1', payload: { novel: true } };

    await peer.receive({ method: 'thread/future/unknownSignal', params });

    expect(notifications.at(-1)).toEqual({ method: 'thread/future/unknownSignal', params });
    expect(writes).toEqual([]);
  });

  it('dispatches a valid approval request to the handler and answers on the wire', async () => {
    const { peer, writes, handled } = makePeer();
    const params = { itemId: 'item-1', startedAtMs: 5, threadId: 'thread-1', turnId: 'turn-1' };

    await peer.receive({ id: 'srv-3', method: 'item/commandExecution/requestApproval', params });

    expect(handled).toEqual([{ method: 'item/commandExecution/requestApproval', params }]);
    expect(writes).toEqual([{ id: 'srv-3', result: { decision: 'accept' } }]);
  });

  it('rejects a frame that fails the pinned envelope schema', async () => {
    const { peer } = makePeer();

    await expect(peer.receive({ noise: true } as never)).rejects.toBeInstanceOf(ProtocolError);
  });
});
