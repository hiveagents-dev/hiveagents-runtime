import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const { verifyPackageMarkdownLinks } = await import(pathToFileURL(resolve('scripts/verify-package-contents.mjs')).href);

it('requires relative Markdown links in npm to point to actual packaged files', () => {
  const files = new Set(['README.md', 'LICENSE', 'docs/examples/quickstart-offline.mjs', 'docs/releases/note.md']);
  const publicLink = '[Guide](https://github.com/hiveagents-dev/hiveagents-runtime/blob/v0.1.0-beta.5/docs/integration-guide.md)';
  expect(() => verifyPackageMarkdownLinks('README.md', `${publicLink}\n[Start](docs/examples/quickstart-offline.mjs) [Jump](#start)`, files)).not.toThrow();
  expect(() => verifyPackageMarkdownLinks('docs/releases/note.md', '[License](../../LICENSE)', files)).not.toThrow();
  expect(() => verifyPackageMarkdownLinks('README.md', '[Setup](docs/integration-guide.md)', files)).toThrow(/outside the tarball/);
});
