import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'adapter-kit': 'src/public/adapter-kit.ts',
    'hosted-runtime': 'src/hosted-runtime.ts',
    'routing/index': 'src/routing/index.ts',
    'routing/learning/index': 'src/routing/learning/index.ts',
    cli: 'src/cli/main.ts',
    'orchestration/index': 'src/orchestration/index.ts',
    'orchestration/graph': 'src/orchestration/workflow/graph.ts',
    'orchestration/memory': 'src/orchestration/memory/index.ts',
    'orchestration/dynamic': 'src/orchestration/dynamic/index.ts',
    'orchestration/log': 'src/orchestration/log/index.ts',
    'memory-tools': 'src/memory-tools/index.ts',
  },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
  // node:sqlite has no unprefixed builtin alias. Preserve Node's module protocol.
  removeNodeProtocol: false,
  // Keep shared public classes identical across the aggregate and pure subpaths.
  splitting: true,
});
