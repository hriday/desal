package org.desal.flink.reportcard;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.connector.kafka.source.reader.deserializer.KafkaRecordDeserializationSchema;
import org.apache.flink.util.Collector;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.desal.flink.common.Json;

/**
 * One record read from {@code plant.events} or {@code plant.status}: its key (the gameId), its
 * JSON value as text, and its Kafka timestamp (the broker's LogAppendTime, epoch ms). A Flink POJO,
 * so it travels between operators without Kryo. The value stays text because a Jackson tree is not
 * a type Flink can serialize; the report-card function parses it.
 */
public class Input {
  public String gameId;
  public String json;
  public long timestamp;

  public Input() {}

  public Input(String gameId, String json, long timestamp) {
    this.gameId = gameId;
    this.json = json;
    this.timestamp = timestamp;
  }

  /**
   * Turns a Kafka record into an {@link Input}. Records with no key or a null value (a tombstone)
   * and values that are not a JSON object are skipped rather than failing the job: one bad record
   * must not stop every game's report card.
   */
  public static class Deserializer implements KafkaRecordDeserializationSchema<Input> {
    @Override
    public void deserialize(ConsumerRecord<byte[], byte[]> record, Collector<Input> out) {
      if (record.key() == null || record.value() == null) {
        return;
      }
      String json = new String(record.value(), StandardCharsets.UTF_8);
      try {
        if (!Json.MAPPER.readTree(json).isObject()) {
          return;
        }
      } catch (IOException e) {
        return;
      }
      out.collect(new Input(new String(record.key(), StandardCharsets.UTF_8), json, record.timestamp()));
    }

    @Override
    public TypeInformation<Input> getProducedType() {
      return TypeInformation.of(Input.class);
    }
  }
}
