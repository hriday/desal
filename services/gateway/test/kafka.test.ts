import { describe, expect, it } from 'vitest';
import { createKafka } from '../src/kafka.js';

describe('Kafka client capabilities /healthz depends on', () => {
  // /healthz would turn not-ok on a consumer crash or disconnect if the client reported them, but
  // @confluentinc/kafka-javascript's KafkaJS API has no consumer events: on() throws "not
  // implemented". If an upgrade adds them, this fails: wire consumer.crash / consumer.disconnect
  // into GatewayKafka.connected then.
  it('the consumer exposes no crash/disconnect events (on() is not implemented)', () => {
    // The typings do not even declare on(); the runtime method exists only to throw.
    const consumer = createKafka('localhost:1').consumer({ kafkaJS: { groupId: 'desal-capability-probe' } }) as unknown as {
      on(event: string, listener: () => void): void;
    };
    expect(() => consumer.on('consumer.crash', () => {})).toThrow(/not implemented/i);
  });
});
