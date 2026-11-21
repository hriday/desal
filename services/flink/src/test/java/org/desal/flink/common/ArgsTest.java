package org.desal.flink.common;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

class ArgsTest {
  @Test
  void defaults() {
    Args a = Args.parse(new String[0]);
    assertEquals("kafka:29092", a.brokers);
    assertEquals("", a.topicSuffix);
    assertEquals("run.results", a.topic(Topics.RUN_RESULTS));
  }

  @Test
  void parsesBrokersAndSuffix() {
    Args a = Args.parse(new String[] {"--topic-suffix", "-it42", "--brokers", "localhost:9092"});
    assertEquals("localhost:9092", a.brokers);
    assertEquals("shift.reports-it42", a.topic(Topics.SHIFT_REPORTS));
  }

  @Test
  void rejectsUnknownOrMissingValues() {
    assertThrows(IllegalArgumentException.class, () -> Args.parse(new String[] {"--nope", "x"}));
    assertThrows(IllegalArgumentException.class, () -> Args.parse(new String[] {"--brokers"}));
  }

  @Test
  void topicNameAppendsSuffix() {
    assertEquals("leaderboard", Topics.name("leaderboard", ""));
    assertEquals("leaderboard", Topics.name("leaderboard", null));
    assertEquals("leaderboard-x", Topics.name("leaderboard", "-x"));
  }
}
