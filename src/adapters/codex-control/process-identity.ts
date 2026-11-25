import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ProcessIdentityRecord {
  pid: number;
  /** ps lstart: full start timestamp, stable for the life of the process. */
  startTime?: string;
  /** ps comm: the executable the pid is running. */
  command?: string;
}

async function psField(pid: number, field: 'lstart' | 'comm'): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', `${field}=`]);
    const value = stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    // ps exits non-zero when the pid does not exist.
    return undefined;
  }
}

/** Records pid + start time + executable so a later kill can prove identity. */
export async function captureProcessIdentity(pid: number): Promise<ProcessIdentityRecord> {
  const [startTime, command] = await Promise.all([psField(pid, 'lstart'), psField(pid, 'comm')]);
  return {
    pid,
    ...(startTime === undefined ? {} : { startTime }),
    ...(command === undefined ? {} : { command }),
  };
}

export type ProcessIdentityVerdict = 'match' | 'exited' | 'mismatch' | 'unverifiable';

/**
 * Verifies that the pid still belongs to the process recorded at spawn. A
 * recycled pid (different start time or executable) is 'mismatch' and must
 * never be signalled. A record with no captured fields is 'unverifiable'.
 */
export async function verifyProcessIdentity(record: ProcessIdentityRecord): Promise<ProcessIdentityVerdict> {
  const current = await captureProcessIdentity(record.pid);
  if (current.startTime === undefined && current.command === undefined) return 'exited';
  if (record.startTime === undefined && record.command === undefined) return 'unverifiable';
  if (record.startTime !== undefined && current.startTime !== undefined && record.startTime !== current.startTime) {
    return 'mismatch';
  }
  if (record.command !== undefined && current.command !== undefined && record.command !== current.command) {
    return 'mismatch';
  }
  return 'match';
}
