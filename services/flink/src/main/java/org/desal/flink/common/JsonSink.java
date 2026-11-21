package org.desal.flink.common;

import java.nio.charset.StandardCharsets;
import org.apache.flink.connector.base.DeliveryGuarantee;
import org.apache.flink.connector.kafka.sink.KafkaRecordSerializationSchema;
import org.apache.flink.connector.kafka.sink.KafkaSink;
import org.apache.flink.util.function.SerializableFunction;
import org.apache.kafka.clients.producer.ProducerRecord;

/** The Kafka sink every job writes with: JSON values under a string key. */
public final class JsonSink {
  private JsonSink() {}

  /**
   * Writes {@code value(x)} as JSON to {@code topic} under the key {@code key(x)}. At-least-once: a
   * record may be written twice after a failure; consumers keep the latest.
   */
  public static <T> KafkaSink<T> of(String brokers, String topic, SerializableFunction<T, String> key,
      SerializableFunction<T, Object> value) {
    return KafkaSink.<T>builder()
        .setBootstrapServers(brokers)
        .setRecordSerializer(new JsonRecord<>(topic, key, value))
        .setDeliveryGuarantee(DeliveryGuarantee.AT_LEAST_ONCE)
        .build();
  }

  /** Writes {@code value(x)} as JSON to {@code topic} under the key {@code key(x)}. */
  static final class JsonRecord<T> implements KafkaRecordSerializationSchema<T> {
    private final String topic;
    private final SerializableFunction<T, String> key;
    private final SerializableFunction<T, Object> value;

    JsonRecord(String topic, SerializableFunction<T, String> key, SerializableFunction<T, Object> value) {
      this.topic = topic;
      this.key = key;
      this.value = value;
    }

    @Override
    public ProducerRecord<byte[], byte[]> serialize(T element, KafkaSinkContext context, Long timestamp) {
      try {
        return new ProducerRecord<>(topic, key.apply(element).getBytes(StandardCharsets.UTF_8),
            Json.MAPPER.writeValueAsBytes(value.apply(element)));
      } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
        throw new IllegalStateException("cannot write " + element, e);
      }
    }
  }
}
