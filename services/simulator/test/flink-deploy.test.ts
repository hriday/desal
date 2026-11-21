import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Static checks on how Flink is wired into the production stack (deploy/), the local stack (infra/)
// and the deploy script. They read the files as text, in the style of compose.test.ts.
const file = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const read = (path: string) => readFileSync(file(path), 'utf8');

/** The text of one top-level compose service: from `  name:` up to the next service or section. */
function service(compose: string, name: string): string {
  const start = compose.search(new RegExp(`^  ${name}:\\s*$`, 'm'));
  expect(start, `service ${name}`).toBeGreaterThanOrEqual(0);
  const rest = compose.slice(start + 1);
  const end = rest.search(/^(  \S|\S)/m);
  return end < 0 ? rest : rest.slice(0, end);
}

describe('deploy/compose.yml: Flink', () => {
  const prod = read('deploy/compose.yml');
  const jobmanager = () => service(prod, 'flink-jobmanager');
  const taskmanager = () => service(prod, 'flink-taskmanager');

  it('runs a jobmanager capped at 700m (process 640m) and a taskmanager capped at 1100m (process 1024m, 2 slots)', () => {
    const jm = jobmanager();
    const tm = taskmanager();
    expect(jm).toMatch(/^\s*command:\s*jobmanager\s*$/m);
    expect(jm).toMatch(/^\s*mem_limit:\s*700m\s*$/m);
    expect(tm).toMatch(/^\s*command:\s*taskmanager\s*$/m);
    expect(tm).toMatch(/^\s*mem_limit:\s*1100m\s*$/m);
    for (const s of [jm, tm]) {
      expect(s).toMatch(/image:\s*\$\{FLINK_IMAGE/);
      expect(s).toMatch(/^\s*-\s*flink-checkpoints:\/flink-data\s*$/m);
    }
    expect(prod).toMatch(/jobmanager\.memory\.process\.size:\s*640m/);
    expect(prod).toMatch(/taskmanager\.memory\.process\.size:\s*1024m/);
    expect(prod).toMatch(/taskmanager\.numberOfTaskSlots:\s*2\b/);
    expect(prod).toMatch(/^volumes:[\s\S]*^\s{2}flink-checkpoints:/m);
    // Both measured at about 120 threads with the two jobs running.
    for (const s of [jm, tm]) expect(s).toMatch(/^\s*pids_limit:\s*512\s*$/m);
  });

  it('publishes the Flink REST/UI only on 127.0.0.1:8082 and never accepts jar uploads', () => {
    const jm = jobmanager();
    const tm = taskmanager();
    expect(jm).toMatch(/^\s*-\s*"?127\.0\.0\.1:8082:8081"?\s*$/m);
    expect(tm).not.toMatch(/^\s*ports:/m);
    // Every published port in the whole file is loopback-only.
    for (const m of prod.matchAll(/^\s*-\s*"?([0-9.]*:?\d+:\d+)"?\s*$/gm)) expect(m[1]).toMatch(/^127\.0\.0\.1:/);
    expect(prod).toMatch(/web\.submit\.enable:\s*false/);
  });

  it('uses Flink 2.x key names for the state backend and the checkpoint and savepoint directories', () => {
    expect(prod).toMatch(/state\.backend\.type:\s*hashmap/);
    expect(prod).toMatch(/execution\.checkpointing\.dir:\s*file:\/\/\/flink-data\/checkpoints/);
    expect(prod).toMatch(/execution\.checkpointing\.savepoint-dir:\s*file:\/\/\/flink-data\/savepoints/);
    // The 1.x names, which Flink 2 no longer reads.
    expect(prod).not.toMatch(/state\.(checkpoints|savepoints)\.dir/);
  });
});

describe('infra/docker-compose.yml: Flink', () => {
  const local = read('infra/docker-compose.yml');
  it('runs the same two Flink services, built from services/flink/Dockerfile, REST on 127.0.0.1:8082', () => {
    const jm = service(local, 'flink-jobmanager');
    const tm = service(local, 'flink-taskmanager');
    for (const s of [jm, tm]) expect(s).toMatch(/dockerfile:\s*services\/flink\/Dockerfile/);
    expect(jm).toMatch(/^\s*-\s*"?127\.0\.0\.1:8082:8081"?\s*$/m);
    expect(local).toMatch(/web\.submit\.enable:\s*false/);
  });
});

describe('deploy/desal.caddy: /flink and /api/leaderboard', () => {
  const caddy = read('deploy/desal.caddy');
  /** The body of the block that opens with `opener {`, up to its matching `}`. */
  function block(opener: string): string {
    const start = caddy.indexOf(`${opener} {`);
    expect(start, opener).toBeGreaterThanOrEqual(0);
    let depth = 0;
    for (let i = caddy.indexOf('{', start); i < caddy.length; i++) {
      if (caddy[i] === '{') depth++;
      else if (caddy[i] === '}' && --depth === 0) return caddy.slice(start, i + 1);
    }
    throw new Error(`unclosed ${opener}`);
  }

  it('serves /flink/ behind the same basic auth and noindex header as /kafka', () => {
    expect(caddy).toMatch(/^\s*redir \/flink \/flink\/\s*$/m);
    const flink = block('handle_path /flink/*');
    expect(flink).toMatch(/basic_auth \{\s*__AUTH_USER__ __AUTH_HASH__\s*\}/);
    expect(flink).toMatch(/header X-Robots-Tag "noindex, nofollow"/);
    expect(flink).toMatch(/reverse_proxy 127\.0\.0\.1:8082/);
  });

  it('never proxies 8082 outside that block', () => {
    const flink = block('handle_path /flink/*');
    const code = caddy.replace(flink, '').replace(/#.*$/gm, '');
    expect(code).not.toMatch(/8082/);
  });

  it('serves /api/leaderboard publicly from the gateway', () => {
    const lb = block('handle /api/leaderboard');
    expect(lb).toMatch(/reverse_proxy 127\.0\.0\.1:8081/);
    expect(lb).not.toMatch(/basic_auth/);
  });
});

describe('scripts/deploy/deploy.sh: Flink', () => {
  const deploy = read('scripts/deploy/deploy.sh');
  it('builds desal-flink and writes FLINK_IMAGE to .env', () => {
    expect(deploy).toMatch(/FLINK_IMAGE="desal-flink:\$COMMIT"/);
    expect(deploy).toMatch(/services\/flink\/Dockerfile -t \$FLINK_IMAGE/);
    expect(deploy).toMatch(/FLINK_IMAGE=%s/);
    expect(deploy).toMatch(/for repo in [^;\n]*desal-flink/);
  });

  it('stops the jobs with savepoints before `docker compose up` and resubmits them after', () => {
    // Commands only: the header comment also mentions these steps.
    const code = deploy.replace(/^\s*#.*$/gm, '');
    const stop = code.indexOf('flink-jobs.sh stop-all /flink-data/savepoints/last.txt');
    const up = code.indexOf('docker compose up -d');
    const submit = code.indexOf('flink-jobs.sh submit-all /flink-data/savepoints/last.txt');
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(up).toBeGreaterThan(stop);
    expect(submit).toBeGreaterThan(up);
    expect(deploy).toMatch(/127\.0\.0\.1:8082\/overview/);
    // The wait loop is bounded by wall-clock time, not only by its iteration count.
    expect(deploy).toMatch(/curl -s --max-time \d+ 127\.0\.0\.1:8082\/overview/);
  });
});

describe('services/flink/flink-jobs.sh', () => {
  const script = file('services/flink/flink-jobs.sh');
  it('is valid bash', () => {
    const r = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('never drops state it cannot restore (no --allowNonRestoredState)', () => {
    const text = readFileSync(script, 'utf8');
    expect(text).not.toMatch(/allowNonRestoredState/);
    // -n is the short form; the CLI arguments are built in `cmd` arrays.
    expect(text).not.toMatch(/cmd\+?=\([^)]*\s-n[\s)]/);
    expect(text).toMatch(/savepoint incompatible, starting fresh/);
  });

  it("keeps a job's previous savepoint line when stop-all takes no new one for it", () => {
    const text = readFileSync(script, 'utf8');
    const stopAll = text.slice(text.indexOf('stop_all() {'), text.indexOf('\n}\n', text.indexOf('stop_all() {')));
    // Both the not-running and the failed-stop branches write the old line back.
    expect(stopAll.match(/echo "\$name=\$old" >>"\$file\.tmp"/g)).toHaveLength(2);
  });

  it('bounds every REST call in wall-clock time', () => {
    const text = readFileSync(script, 'utf8');
    const calls = text.replace(/#.*$/gm, '').match(/curl [^|\n]*/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toMatch(/--max-time \d+/);
  });
});

describe('services/flink/Dockerfile', () => {
  it("caps Maven's heap so the build cannot push the small server into swap", () => {
    expect(read('services/flink/Dockerfile')).toMatch(/^ENV MAVEN_OPTS=-Xmx512m$/m);
  });
});
