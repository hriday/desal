import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const DEPLOY = fileURLToPath(new URL('../../../scripts/deploy/deploy.sh', import.meta.url));

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A throwaway repo holding a copy of deploy.sh, with `ssh` and `pnpm` replaced by stubs that only
 * record that they were called: the script never reaches a real server or build from here.
 */
function sandbox(): { repo: string; calls: string; run: () => ReturnType<typeof spawnSync> } {
  dir = mkdtempSync(join(tmpdir(), 'desal-deploy-'));
  const repo = join(dir, 'repo');
  const bin = join(dir, 'bin');
  const calls = join(dir, 'calls.log');
  mkdirSync(join(repo, 'scripts/deploy'), { recursive: true });
  mkdirSync(bin);
  copyFileSync(DEPLOY, join(repo, 'scripts/deploy/deploy.sh'));
  for (const tool of ['ssh', 'pnpm']) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${calls}"\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  writeFileSync(calls, '');
  const git = (...args: string[]) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'add', '.');
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const run = () =>
    spawnSync('bash', [join(repo, 'scripts/deploy/deploy.sh')], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DESAL_SERVER: 'nobody@127.0.0.1', DESAL_HOST: 'example.invalid' },
    });
  return { repo, calls, run };
}

describe('scripts/deploy/deploy.sh', () => {
  it('fails on a dirty tree (a modified file) before building or contacting the server', () => {
    const { repo, calls, run } = sandbox();
    writeFileSync(join(repo, 'scripts/deploy/deploy.sh'), readFileSync(join(repo, 'scripts/deploy/deploy.sh'), 'utf8') + '\n# local edit\n');
    const r = run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/uncommitted changes/);
    expect(readFileSync(calls, 'utf8')).toBe('');
  });

  it('fails on an untracked file too (the web app is built from the working tree)', () => {
    const { repo, calls, run } = sandbox();
    writeFileSync(join(repo, 'stray.txt'), 'x');
    const r = run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/uncommitted changes/);
    expect(readFileSync(calls, 'utf8')).toBe('');
  });
});
