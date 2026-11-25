/**
 * W5 adversary: an "agent" acting in the worktree path it was given, with the user's file access.
 * Each vector plants programs that append to `<sentinel>/<vector>.log` when executed. Every write is
 * recorded (path, kind, content or link target, where) so the simulation can check nothing is lost.
 *
 * Vector classes (where the plant lives):
 * - worktree: only files under the worktree (pointer rewrite, attributes, symlinks, files, edits, dir swap)
 * - admin:    the worktree's admin dir `<common>/worktrees/<name>` (reached through the .git pointer)
 * - common:   the repository's own git dir (config, hooks, info/attributes, include files)
 */
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const VECTORS = {
  pointer: 'worktree', attributesOnly: 'worktree', symlinks: 'worktree', files: 'worktree', modifyTracked: 'worktree', swapDir: 'worktree',
  hooksAdmin: 'admin', adminConfigOnly: 'admin', commondirRedirect: 'admin', gitdirBackpointer: 'admin',
  hooksCommon: 'common', fsmonitorConfig: 'common', filterCommon: 'common', filterInclude: 'common', filterWorktreeConfig: 'common',
};
const HOOKS = ['pre-commit', 'post-checkout', 'post-merge', 'post-index-change', 'reference-transaction', 'fsmonitor-watchman', 'pre-auto-gc', 'post-rewrite', 'pre-push'];

export function adversary({ worktree, base, sentinel, chosen }) {
  const writes = [];
  const record = (path, where) => writes.push({ path, where, kind: 'file', content: readFileSync(path, 'utf8') });
  const write = (path, content, where, mode) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    if (mode) chmodSync(path, mode);
    record(path, where);
  };
  const append = (path, content, where) => { appendFileSync(path, content); record(path, where); };
  const link = (target, path, where) => { symlinkSync(target, path); writes.push({ path, where, kind: 'symlink', target }); };
  const program = (vector, filter) => {
    const path = join(base, 'planted', `${vector}-${filter ? 'filter' : 'hook'}.sh`);
    if (!existsSync(path)) {
      write(path, `#!/bin/sh\nmkdir -p '${sentinel}'\necho "$0 $*" >> '${sentinel}/${vector}.log'\n${filter ? 'exec cat\n' : 'exit 0\n'}`, 'outside', 0o755);
    }
    return path;
  };
  const admin = readFileSync(join(worktree, '.git'), 'utf8').match(/^gitdir: (.+)\n$/)[1];
  const common = resolve(admin, readFileSync(join(admin, 'commondir'), 'utf8').trim());
  const sameSizeEdit = () => {
    const file = join(worktree, 'a.txt');
    // Same size, new content and mtime: git must re-read it (through any clean filter) to compare. Idempotent.
    write(file, readFileSync(file, 'utf8').toUpperCase(), 'worktree');
  };
  const attributes = line => append(join(worktree, '.gitattributes'), `${line}\n`, 'worktree');
  const filterSection = (name, vector) => `[filter "${name}"]\n\tclean = ${program(vector, true)}\n\tsmudge = ${program(vector, true)}\n`
    + `[diff "${name}"]\n\tcommand = ${program(vector, false)}\n\ttextconv = ${program(vector, true)}\n`;

  const act = {
    pointer() {
      const evil = join(base, 'evil-gitdir');
      write(join(evil, 'HEAD'), readFileSync(join(admin, 'HEAD'), 'utf8'), 'outside');
      write(join(evil, 'commondir'), `${common}\n`, 'outside');
      write(join(evil, 'config'), `[core]\n\tfsmonitor = ${program('pointer', false)}\n\thooksPath = ${join(base, 'evil-hooks')}\n${filterSection('evilp', 'pointer')}`, 'outside');
      for (const hook of HOOKS) write(join(base, 'evil-hooks', hook), `#!/bin/sh\nexec '${program('pointer', false)}'\n`, 'outside', 0o755);
      write(join(worktree, '.git'), `gitdir: ${evil}\n`, 'worktree');
      attributes('* filter=evilp diff=evilp');
      sameSizeEdit();
    },
    attributesOnly() { attributes('*.txt filter=lfs diff=evila merge=evila'); sameSizeEdit(); },
    symlinks() {
      const outsideDir = join(base, 'outside-dir');
      write(join(outsideDir, 'keep.txt'), 'outside content\n', 'outside');
      link(outsideDir, join(worktree, 'link-out'), 'worktree');
      link(join(base, 'outside-dir', 'keep.txt'), join(worktree, 'link-file'), 'worktree');
      write(join(base, 'outside-attrs'), '* filter=evilc\n', 'outside');
      if (!existsSync(join(worktree, '.gitattributes'))) link(join(base, 'outside-attrs'), join(worktree, '.gitattributes'), 'worktree');
    },
    files() {
      write(join(worktree, 'new.txt'), 'untracked work\n', 'worktree');
      write(join(worktree, 'deep', 'nested', 'n.md'), '# nested\n', 'worktree');
      write(join(worktree, 'ignored', 'secret.txt'), 'ignored work\n', 'worktree');
      write(join(worktree, 'debug.log'), 'ignored log\n', 'worktree');
    },
    modifyTracked() { sameSizeEdit(); write(join(worktree, 'src', 'b.txt'), 'changed body of b\n', 'worktree'); },
    swapDir() {
      // Replace the worktree directory by a symlink to a moved copy of itself.
      const moved = `${worktree}.moved`;
      renameSync(worktree, moved);
      symlinkSync(moved, worktree);
      writes.push({ path: worktree, where: 'worktree', kind: 'symlink', target: moved });
      write(join(moved, 'after-swap.txt'), 'written after the swap\n', 'worktree');
    },
    hooksAdmin() { for (const hook of HOOKS) write(join(admin, 'hooks', hook), `#!/bin/sh\nexec '${program('hooksAdmin', false)}'\n`, 'admin', 0o755); },
    adminConfigOnly() {
      write(join(admin, 'config.worktree'), `[core]\n\tfsmonitor = ${program('adminConfigOnly', false)}\n${filterSection('evilw0', 'adminConfigOnly')}`, 'admin');
      attributes('* filter=evilw0 diff=evilw0');
      sameSizeEdit();
    },
    commondirRedirect() {
      const evil = join(base, 'evil-common');
      cpSync(common, evil, { recursive: true });
      append(join(evil, 'config'), `[core]\n\tfsmonitor = ${program('commondirRedirect', false)}\n${filterSection('evilr', 'commondirRedirect')}`, 'outside');
      write(join(evil, 'info', 'attributes'), '* filter=evilr\n', 'outside');
      write(join(admin, 'commondir'), `${evil}\n`, 'admin');
      attributes('* filter=evilr diff=evilr');
      sameSizeEdit();
    },
    gitdirBackpointer() { write(join(admin, 'gitdir'), `${join(base, 'nowhere', '.git')}\n`, 'admin'); },
    hooksCommon() { for (const hook of HOOKS) write(join(common, 'hooks', hook), `#!/bin/sh\nexec '${program('hooksCommon', false)}'\n`, 'common', 0o755); },
    fsmonitorConfig() {
      const hooks = join(base, 'evil-hooks-common');
      for (const hook of HOOKS) write(join(hooks, hook), `#!/bin/sh\nexec '${program('fsmonitorConfig', false)}'\n`, 'outside', 0o755);
      append(join(common, 'config'), `[core]\n\tfsmonitor = ${program('fsmonitorConfig', false)}\n\thooksPath = ${hooks}\n\tuntrackedCache = true\n`, 'common');
    },
    filterCommon() {
      append(join(common, 'config'), filterSection('evilc', 'filterCommon'), 'common');
      write(join(common, 'info', 'attributes'), '* filter=evilc diff=evilc\n', 'common');
      attributes('* filter=evilc diff=evilc');
      sameSizeEdit();
    },
    filterInclude() {
      write(join(base, 'evil-include.cfg'), filterSection('evili', 'filterInclude'), 'outside');
      append(join(common, 'config'), `[include]\n\tpath = ${join(base, 'evil-include.cfg')}\n[includeIf "gitdir:/"]\n\tpath = ${join(base, 'evil-include.cfg')}\n`, 'common');
      attributes('* filter=evili diff=evili');
      sameSizeEdit();
    },
    filterWorktreeConfig() {
      append(join(common, 'config'), '[extensions]\n\tworktreeConfig = true\n', 'common');
      write(join(admin, 'config.worktree'), `[core]\n\tfsmonitor = ${program('filterWorktreeConfig', false)}\n${filterSection('evilw', 'filterWorktreeConfig')}`, 'admin');
      attributes('* filter=evilw diff=evilw');
      sameSizeEdit();
    },
  };
  // The directory swap goes last so every other plant uses the real path.
  for (const vector of [...chosen.filter(v => v !== 'swapDir'), ...chosen.filter(v => v === 'swapDir')]) act[vector]();
  // Final content of every file written (a later write may have gone through a symlink the agent made).
  for (const entry of writes) if (entry.kind === 'file') { try { entry.content = readFileSync(entry.path, 'utf8'); } catch { /* checked later */ } }
  return { writes, admin, common };
}
