import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FileWorkflowStore, WorkflowRunner, type WorkflowStepContext } from '../../../src/orchestration/workflow/index.js';

const [directory, mode, replay] = process.argv.slice(2) as [string, string, string];
async function record(context: WorkflowStepContext) {
  await appendFile(join(directory, 'executions.jsonl'), `${JSON.stringify({
    step: context.stepId, attempt: context.attempt, key: context.idempotencyKey,
  })}\n`);
}
try {
  const result = await new WorkflowRunner(new FileWorkflowStore(directory)).run({
    id: 'crash-fixture', version: '1', steps: [
      { id: 'intake', async execute(context) { await record(context); return 'ready'; } },
      { id: 'work', dependencies: ['intake'], maxAttempts: 2, replaySafe: replay === 'true', async execute(context) {
        await record(context);
        process.send?.({ type: 'executing' });
        if (mode === 'crash') await new Promise(() => { setInterval(() => {}, 1000); });
        return 'work';
      } },
      { id: 'finish', dependencies: ['work'], async execute(context) { await record(context); return 'done'; } },
    ],
  }, { runId: 'crash' });
  process.send?.({ type: 'result', status: result.status });
} catch (error) {
  process.send?.({ type: 'error', name: error instanceof Error ? error.name : 'unknown' });
  process.exitCode = 1;
}
