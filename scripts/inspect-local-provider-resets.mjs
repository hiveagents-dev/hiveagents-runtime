#!/usr/bin/env node
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectProviderReset } from './capture-provider-reset.mjs';
import { parseCaptureJson } from './lib/provider-reset-json.mjs';

const CAPS = Object.freeze({ maxFiles: 256, maxBytes: 536_870_912, maxFileBytes: 33_554_432,
  maxFrameBytes: 1_048_576, maxSamples: 24, maxEntries: 8192, maxDepth: 6,
  maxRecords: 100_000, maxGroups: 64 });
const version = value => typeof value === 'string'
  && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|rc)\.\d{1,4})?$/.test(value) ? value : undefined;
const time = value => typeof value === 'string'
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value)
  && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
const sha = value => createHash('sha256').update(value).digest('hex');

async function discover(root, state, depth = 0) {
  if (depth > CAPS.maxDepth || state.visited >= CAPS.maxEntries) { state.truncated = true; return; }
  let entries;
  try { if (!(await lstat(root)).isDirectory()) return; entries = await readdir(root, { withFileTypes: true }); }
  catch { state.unavailable++; return; }
  for (const entry of entries) {
    if (++state.visited > CAPS.maxEntries) { state.truncated = true; break; }
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) await discover(path, state, depth + 1);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const info = await lstat(path);
      state.files.push({ path, mtime: info.mtimeMs });
    }
  }
}

/** Testable bounded reader. Paths stay private; no caller-supplied DTO becomes execution proof. */
export async function inspectResetFiles(provider, files) {
  if (!['claude', 'codex'].includes(provider)) throw new Error('Inspection refused');
  const inventory = { discovered: files.length, opened: 0, skippedBudget: 0, sampledLargeFiles: 0,
    unavailable: 0, bytes: 0, frames: 0, relevant: 0, invalidRelevantFrames: 0, oversizedFrames: 0,
    groupOverflow: 0 };
  const samples = [], groups = new Map();
  for (const file of files.slice().sort((a, b) => b.mtime - a.mtime)) {
    if (inventory.opened >= CAPS.maxFiles || inventory.frames >= CAPS.maxRecords) { inventory.skippedBudget++; continue; }
    let fd;
    try {
      const before = await lstat(file.path);
      if (!before.isFile() || before.isSymbolicLink()) { inventory.unavailable++; continue; }
      fd = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const pinned = await fd.stat();
      if (pinned.dev !== before.dev || pinned.ino !== before.ino || !pinned.isFile()) throw new Error();
      const charged = Math.min(pinned.size, CAPS.maxFileBytes);
      if (inventory.bytes + charged > CAPS.maxBytes) { inventory.skippedBudget++; continue; }
      inventory.opened++;
      const large = pinned.size > CAPS.maxFileBytes;
      if (large) inventory.sampledLargeFiles++;
      const ranges = large ? [[0, CAPS.maxFrameBytes],
        [pinned.size - CAPS.maxFileBytes + CAPS.maxFrameBytes, pinned.size]] : [[0, pinned.size]];
      let cliVersion = 'unverified';
      for (const [start, end] of ranges) {
        let pending = Buffer.alloc(CAPS.maxFrameBytes), used = 0, dropping = start > 0, offset = start,
          frameStart = start;
        const accept = raw => {
          inventory.frames++;
          // Never parse arbitrary prompt/response lines merely to discover metadata.
          if (!raw.includes(Buffer.from('rate_limit')) && !raw.includes(Buffer.from('rateLimit'))
            && !raw.includes(Buffer.from('usage_limit')) && !raw.includes(Buffer.from('session_meta'))) return;
          let row;
          try { row = parseCaptureJson(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
          catch { inventory.invalidRelevantFrames++; return; }
          if (provider === 'codex' && row.type === 'session_meta') {
            cliVersion = version(row.payload?.cli_version) ?? cliVersion; return;
          }
          if (provider === 'claude') cliVersion = version(row.version) ?? cliVersion;
          const nested = row.type === 'event_msg' && row.payload?.type === 'error' ? row.payload : row;
          const item = projectProviderReset(nested, provider); if (!item) return;
          inventory.relevant++;
          const key = JSON.stringify({ cliVersion, shape: item.shape, classification: item.classification,
            status: item.status, providerCode: item.providerCode,
            lanes: item.windows.map(w => ({ lane: w.lane, windowMinutes: w.windowMinutes })) });
          if (!groups.has(key) && groups.size >= CAPS.maxGroups) { inventory.groupOverflow++; return; }
          const group = groups.get(key) ?? { ...JSON.parse(key), count: 0, windowsAtOrAbove100: 0 };
          group.count++;
          for (const w of item.windows) {
            if (w.usedPercent !== undefined) {
              group.minUsedPercent = Math.min(group.minUsedPercent ?? w.usedPercent, w.usedPercent);
              group.maxUsedPercent = Math.max(group.maxUsedPercent ?? w.usedPercent, w.usedPercent);
              if (w.usedPercent >= 100) group.windowsAtOrAbove100++;
            }
          }
          groups.set(key, group);
          if (samples.length < CAPS.maxSamples && samples.filter(s => s.group === key).length < 3) {
            const observedAt = time(row.timestamp);
            samples.push({ group: key, source: { store: provider === 'codex' ? 'local-codex-sessions'
              : 'local-claude-project-sessions', recordSha256: sha(raw), byteOffset: frameStart },
            cliVersion, cliVersionEvidence: cliVersion === 'unverified' ? 'unsupported-or-absent' : 'existing-session-metadata',
            ...(observedAt ? { observedAt } : {}), ...item });
          }
        };
        const chunk = Buffer.alloc(65_536);
        while (offset < end && inventory.frames < CAPS.maxRecords) {
          const { bytesRead } = await fd.read(chunk, 0, Math.min(chunk.length, end - offset), offset);
          if (!bytesRead) break;
          inventory.bytes += bytesRead;
          for (let i = 0; i < bytesRead; i++) {
            if (chunk[i] === 10) {
              if (!dropping && used && inventory.frames < CAPS.maxRecords) accept(pending.subarray(0, used));
              used = 0; dropping = false; frameStart = offset + i + 1;
            } else if (!dropping) {
              if (used === CAPS.maxFrameBytes) { inventory.oversizedFrames++; dropping = true; used = 0; }
              else pending[used++] = chunk[i];
            }
          }
          offset += bytesRead;
        }
        // A sampled head/tail boundary is not a complete final frame.
        if (used && !dropping && end === pinned.size && inventory.frames < CAPS.maxRecords) accept(pending.subarray(0, used));
        pending.fill(0); chunk.fill(0);
      }
    } catch { inventory.unavailable++; }
    finally { if (fd) await fd.close(); }
  }
  return { provider, inventory, groups: [...groups.values()], samples: samples.map(({ group, ...sample }) => sample) };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== '--opt-in') throw new Error('Inspection refused: explicit --opt-in required');
  const codex = { files: [], visited: 0, unavailable: 0, truncated: false },
    claude = { files: [], visited: 0, unavailable: 0, truncated: false };
  await discover(join(homedir(), '.codex/sessions'), codex);
  // Project transcript stores only, not ~/.claude credentials/config or arbitrary projects.
  let projects = [];
  try { projects = await readdir(join(homedir(), '.claude/projects'), { withFileTypes: true }); }
  catch { claude.unavailable++; }
  for (const entry of projects) if (entry.isDirectory() && !entry.isSymbolicLink()
    && entry.name.endsWith('open-agent-runtime'))
    await discover(join(homedir(), '.claude/projects', entry.name), claude);
  const stores = [];
  for (const [provider, state] of [['codex', codex], ['claude', claude]]) {
    const result = await inspectResetFiles(provider, state.files);
    stores.push({ ...result, discovery: { visited: state.visited, unavailable: state.unavailable,
      truncated: state.truncated } });
  }
  process.stdout.write(JSON.stringify({ schemaVersion: 1, kind: 'bounded-local-provider-reset-study',
    capturedAt: new Date().toISOString(), caps: CAPS, timestampUnits: 'unverified', stores }) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => { process.stderr.write('Inspection refused\n'); process.exitCode = 1; });
