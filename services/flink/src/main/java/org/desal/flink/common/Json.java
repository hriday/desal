package org.desal.flink.common;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;

/** The one Jackson mapper for every record the jobs read from or write to Kafka. */
public final class Json {
  /**
   * Writes nulls (the zod schemas use explicit {@code null}, e.g. {@code vsBest}, {@code verdict})
   * and ignores fields it does not know when reading, so the simulator can add event fields
   * without breaking the jobs. ObjectMapper is thread-safe once configured.
   */
  public static final ObjectMapper MAPPER = new ObjectMapper()
      .setDefaultPropertyInclusion(JsonInclude.Include.ALWAYS)
      .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);

  private Json() {}
}
