export class DependencyCycleError extends Error {
  constructor(readonly cycle: readonly string[]) {
    super(`Dependency graph contains a cycle: ${cycle.join(' -> ')}`);
    this.name = 'DependencyCycleError';
  }
}

/** Iterative DFS is used only for a rejected graph's diagnostic cycle path. */
function cyclePath(tasks: ReadonlyMap<string, { dependencies?: readonly string[] }>): string[] {
  const visited = new Set<string>();
  for (const root of tasks.keys()) {
    if (visited.has(root)) continue;
    const path: Array<{ id: string; index: number }> = [{ id: root, index: 0 }];
    const active = new Map([[root, 0]]);
    while (path.length) {
      const last = path[path.length - 1]!;
      const next = (tasks.get(last.id)!.dependencies ?? [])[last.index++];
      if (next === undefined) {
        visited.add(last.id); active.delete(last.id); path.pop(); continue;
      }
      const cycleStart = active.get(next);
      if (cycleStart !== undefined) return [...path.slice(cycleStart).map(frame => frame.id), next];
      if (visited.has(next)) continue;
      active.set(next, path.length); path.push({ id: next, index: 0 });
    }
  }
  return [];
}

/** Browser-safe DAG layering. Each wave waits for all preceding waves. */
export function dependencyWaves<T extends { id: string; dependencies?: readonly string[] }>(
  tasks: readonly T[],
): T[][] {
  const byId = new Map<string, T>();
  const order = new Map<string, number>();
  for (const [index, task] of tasks.entries()) {
    if (typeof task.id !== 'string' || !task.id.trim()) throw new Error('A task id must be nonempty');
    if (byId.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    byId.set(task.id, task);
    order.set(task.id, index);
  }
  const waiting = new Map<string, number>();
  const readers = new Map<string, string[]>();
  for (const task of tasks) {
    const dependencies = task.dependencies ?? [];
    if (!Array.isArray(dependencies)) throw new Error(`Invalid dependencies for ${task.id}`);
    if (new Set(dependencies).size !== dependencies.length) throw new Error(`Duplicate dependency for ${task.id}`);
    waiting.set(task.id, dependencies.length);
    for (const id of dependencies) {
      if (!byId.has(id)) throw new Error(`Unknown dependency ${id} for ${task.id}`);
      const list = readers.get(id) ?? [];
      list.push(task.id);
      readers.set(id, list);
    }
  }
  let ready = tasks.filter(task => waiting.get(task.id) === 0);
  const waves: T[][] = [];
  let visited = 0;
  while (ready.length) {
    waves.push(ready);
    visited += ready.length;
    const next: T[] = [];
    for (const task of ready) {
      for (const id of readers.get(task.id) ?? []) {
        const remaining = waiting.get(id)! - 1;
        waiting.set(id, remaining);
        if (remaining === 0) next.push(byId.get(id)!);
      }
    }
    ready = next.sort((left, right) => order.get(left.id)! - order.get(right.id)!);
  }
  if (visited !== tasks.length) throw new DependencyCycleError(cyclePath(byId));
  return waves;
}
