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
