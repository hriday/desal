package org.desal.flink.reportcard;

import org.apache.flink.types.PojoTestUtils;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * GameState is the report-card job's keyed state (Task 7), and everything it holds goes into
 * checkpoints and savepoints. PojoTestUtils fails if the class is not a Flink POJO or if any field,
 * however deeply nested (List and Map elements included), would be serialized with Kryo, which
 * cannot evolve its schema across savepoints.
 */
class GameStateTest {

  @ParameterizedTest
  @ValueSource(classes = {GameState.class, GameState.KindTally.class, ShiftTracker.class, OpenEvent.class,
      StatusView.class, StatusView.Loop.class})
  void isSerializedAsAPojoWithoutKryo(Class<?> type) {
    PojoTestUtils.assertSerializedAsPojoWithoutKryo(type);
  }
}
