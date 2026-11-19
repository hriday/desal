import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const compose = readFileSync(fileURLToPath(new URL('../../../infra/docker-compose.yml', import.meta.url)), 'utf8');

describe('infra/docker-compose.yml', () => {
  it('points Kafka log.dirs at the mounted data volume, so down/up keeps the career', () => {
    const logDirs = /^\s*KAFKA_LOG_DIRS:\s*"?([^"\s]+)"?\s*$/m.exec(compose)?.[1];
    const mount = /^\s*-\s*desal-kafka-data:([^\s:]+)\s*$/m.exec(compose)?.[1];
    expect(mount).toBeDefined();
    // Without KAFKA_LOG_DIRS the apache/kafka image writes to /tmp/kafka-logs, outside the volume.
    expect(logDirs).toBe(mount);
  });
});

describe('deploy/compose.yml', () => {
  const prod = readFileSync(fileURLToPath(new URL('../../../deploy/compose.yml', import.meta.url)), 'utf8');
  it('describes plant.state as per-game saves, not the single-career save of before games existed', () => {
    expect(prod).not.toMatch(/career/i);
    expect(prod).toMatch(/every game's save/);
  });
});

describe('scripts/deploy/deploy.sh', () => {
  const deploy = readFileSync(fileURLToPath(new URL('../../../scripts/deploy/deploy.sh', import.meta.url)), 'utf8');
  it("waits for the line the simulator really logs once it runs ('running with N live game(s)')", () => {
    const pattern = /docker logs desal-simulator 2>&1 \| grep -qE '([^']+)'/.exec(deploy)?.[1];
    expect(pattern).toBeDefined();
    expect(new RegExp(pattern!).test('[sim] running with 3 live game(s)')).toBe(true);
  });
});
