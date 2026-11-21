package org.desal.flink.leaderboard;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashSet;
import java.util.Set;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.streaming.api.graph.StreamNode;
import org.desal.flink.common.Args;
import org.junit.jupiter.api.Test;

/**
 * Builds the job's graph without running it (nothing connects to Kafka). Translating the SQL
 * also validates the Kafka table options, since the connector factories check them then.
 */
class LeaderboardJobTest {

  @Test
  void theDataStreamOperatorsHaveStableUids() {
    StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
    LeaderboardJob.define(env, Args.parse(new String[] {"--topic-suffix", "-t"}));
    Set<String> uids = new HashSet<>();
    for (StreamNode node : env.getStreamGraph().getStreamNodes()) {
      if (node.getTransformationUID() != null) {
        uids.add(node.getTransformationUID());
      }
    }
    assertTrue(uids.containsAll(Set.of("ranked-to-input", "stats-to-input", "online-to-input", "board-assembler",
        "leaderboard-sink", "run-ranks-sink")), uids.toString());
    assertEquals(1, env.getParallelism());
    assertEquals(LeaderboardJob.CHECKPOINT_EVERY_MS, env.getCheckpointConfig().getCheckpointInterval());
  }
}
