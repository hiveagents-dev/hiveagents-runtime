import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Vitest owns the SDK's own suite and nothing else. Git-ignored plugin
    // trees (`.agents/`, `.claude/skills/`) ship their own vitest suites and
    // were being collected — 1,156 foreign files in a run where nothing of
    // ours was broken. A positive include names what is ours instead of
    // chasing every future folder with an exclude.
    include: ['tests/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.{idea,git,cache,output,temp}/**',
    ],
  },
});
