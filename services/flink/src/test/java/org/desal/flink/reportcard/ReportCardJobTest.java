package org.desal.flink.reportcard;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashSet;
import java.util.Set;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.streaming.api.graph.StreamGraph;
import org.apache.flink.streaming.api.graph.StreamNode;
import org.desal.flink.common.Args;
import org.junit.jupiter.api.Test;

/**
 * Builds the job's graph without running it (nothing connects to Kafka). Building fails if an
 * operator has no uid, because the job turns auto-generated uids off: savepoints map state to
 * operators by uid, so every operator must keep a stable one across redeploys.
 */
class ReportCardJobTest {

  @Test
  void everyOperatorHasAStableUid() {
    StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
    ReportCardJob.define(env, Args.parse(new String[] {"--topic-suffix", "-t"}));
    StreamGraph graph = env.getStreamGraph();
    Set<String> uids = new HashSet<>();
    for (StreamNode node : graph.getStreamNodes()) {
      if (node.getTransformationUID() != null) {
        uids.add(node.getTransformationUID());
      }
    }
    assertTrue(uids.containsAll(Set.of("plant-events-source", "plant-status-source", "report-card")), uids.toString());
    assertEquals(1, env.getParallelism());
    assertEquals(ReportCardJob.CHECKPOINT_EVERY_MS, env.getCheckpointConfig().getCheckpointInterval());
  }
}
