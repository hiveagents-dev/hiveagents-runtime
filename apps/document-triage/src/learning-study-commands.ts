import { studyTask } from './learning-curriculum.js';
import { captureStudyOptions, openStudyApplication, type StudyAppOptions } from './learning-study-session.js';

async function withStudy<T>(options: ReturnType<typeof captureStudyOptions>, execute: boolean,
  callback: (session: Awaited<ReturnType<typeof openStudyApplication>>) => Promise<T>): Promise<T> {
  const session = await openStudyApplication(options, execute);
  let failed = false, original: unknown;
  try { return await callback(session); }
  catch (error) { failed = true; original = error; throw error; }
  finally {
    try { session.close(); }
    catch (error) { if (failed) throw new AggregateError([original, error], 'Study operation and cleanup failed'); throw error; }
  }
}

export async function studyStatus(options: StudyAppOptions) {
  const captured = captureStudyOptions(options);
  return withStudy(captured, false, async session => ({ pid: process.pid, ...await session.runner.inspect(), routingApiCalls: 0 }));
}

export async function studyCycle(options: StudyAppOptions) {
  const captured = captureStudyOptions(options);
  return withStudy(captured, true, async session => ({ pid: process.pid, ...await session.runner.run({ maxLaunches: captured.maxLaunches!,
    ...(captured.cycles === undefined ? {} : { cycles: captured.cycles }),
    ...(captured.operation === undefined ? {} : { operation: captured.operation }),
    ...(captured.batchId === undefined ? {} : { batchId: captured.batchId }),
    ...(captured.signal === undefined ? {} : { signal: captured.signal }) }), modelLaunches: null, routingApiCalls: 0 }));
}

export async function studyRun(options: StudyAppOptions & { input: unknown; autoImprove?: boolean }) {
  const captured = { ...captureStudyOptions(options), input: studyTask(options.input), autoImprove: options.autoImprove === true };
  return withStudy(captured, true, async session => {
    const { turn, ...result } = await session.runner.runTask({ task: captured.input, maxLaunches: captured.maxLaunches!, autoImprove: captured.autoImprove,
      ...(captured.cycles === undefined ? {} : { cycles: captured.cycles }), ...(captured.signal === undefined ? {} : { signal: captured.signal }) });
    return { pid: process.pid, ...result, ...(turn === undefined ? {} : { text: turn.text }), modelLaunches: null, routingApiCalls: 0 };
  });
}
