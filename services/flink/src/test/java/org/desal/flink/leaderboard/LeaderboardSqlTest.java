package org.desal.flink.leaderboard;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.runtime.testutils.MiniClusterResourceConfiguration;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.table.api.Schema;
import org.apache.flink.table.api.Table;
import org.apache.flink.table.api.bridge.java.StreamTableEnvironment;
import org.apache.flink.table.connector.ChangelogMode;
import org.apache.flink.test.junit5.MiniClusterExtension;
import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;
import org.apache.flink.util.CloseableIterator;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.RegisterExtension;

/**
 * Runs {@link LeaderboardSql#queries} on a local MiniCluster. The test registers its own
 * {@code runs} (an upsert table built from a changelog stream with runId as primary key, which is
 * what the upsert-kafka table is) and {@code status} tables, so no Kafka is needed. Each query's
 * changelog is replayed into the table it describes before asserting.
 */
class LeaderboardSqlTest {
  @RegisterExtension
  static final MiniClusterExtension CLUSTER = new MiniClusterExtension(
      new MiniClusterResourceConfiguration.Builder().setNumberTaskManagers(1).setNumberSlotsPerTaskManager(2).build());

  private static final long T0 = 1_795_651_200_000L;
  private static final String[] RUN_FIELDS = {
      "runId", "callSign", "mode", "endedAt", "shiftsCompleted", "totalProductM3", "endReason", "kinds"};
  private static final TypeInformation<Row> KIND = Types.ROW_NAMED(
      new String[] {"kind", "count", "handledWell", "meanResponseMinutes", "firstHandledWell"},
      Types.STRING, Types.INT, Types.INT, Types.DOUBLE, Types.BOOLEAN);
  private static final TypeInformation<Row> RUN = Types.ROW_NAMED(RUN_FIELDS,
      Types.STRING, Types.STRING, Types.STRING, Types.LONG, Types.INT, Types.DOUBLE, Types.STRING,
      Types.OBJECT_ARRAY(KIND));

  private final List<Row> runs = new ArrayList<>();

  @BeforeEach
  void reset() {
    runs.clear();
  }

  @Test
  void twelveRunsRankByWaterThenShiftsThenTheEarlierRun() throws Exception {
    for (int i = 1; i <= 8; i++) {
      add("r" + i, "normal", 1000 - 10 * i, 3, T0 + i);
    }
    add("fewerShifts", "normal", 500, 2, T0);
    add("moreShifts", "normal", 500, 4, T0);
    add("later", "normal", 400, 3, T0 + 100);
    add("earlier", "normal", 400, 3, T0 + 50);

    List<Row> ranked = ranked();
    assertEquals(12, ranked.size());
    assertEquals(List.of("r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "moreShifts", "fewerShifts", "earlier", "later"),
        runIds(ranked));
    for (int i = 0; i < 12; i++) {
      assertEquals(i + 1L, ((Number) ranked.get(i).getField("rn")).longValue());
    }
    Row first = ranked.get(0);
    assertEquals("Call-r1", first.getField("callSign"));
    assertEquals(3, first.getField("shiftsCompleted"));
    assertEquals(990.0, first.getField("totalProductM3"));
    assertEquals(T0 + 1, first.getField("endedAt"));
  }

  @Test
  void anUpsertMovesARunUpWithoutDuplicatingIt() throws Exception {
    for (int i = 1; i <= 12; i++) {
      add("r" + i, "normal", 1000 - 10 * i, 3, T0 + i);
    }
    upsert("r12", "normal", 2000, 3, T0 + 12);

    List<Row> ranked = ranked();
    assertEquals(12, ranked.size());
    assertEquals("r12", ranked.get(0).getField("runId"));
    assertEquals(2000.0, ranked.get(0).getField("totalProductM3"));
    assertEquals("r1", ranked.get(1).getField("runId"));
    assertEquals(2L, ((Number) ranked.get(1).getField("rn")).longValue());
    assertEquals(12, Set.copyOf(runIds(ranked)).size());
  }

  @Test
  void rankingIsPartitionedByMode() throws Exception {
    add("normal1", "normal", 500, 3, T0);
    add("hard1", "hard", 500, 3, T0);
    add("hardBig", "hard", 900, 3, T0);

    Map<String, Long> rn = new HashMap<>();
    for (Row r : ranked()) {
      rn.put((String) r.getField("runId"), ((Number) r.getField("rn")).longValue());
    }
    // The Hard run with more water takes Hard's first place and leaves Normal's alone.
    assertEquals(1L, rn.get("normal1"));
    assertEquals(1L, rn.get("hardBig"));
    assertEquals(2L, rn.get("hard1"));
  }

  @Test
  void statsCountOperatorsAndFirstHandledWellPerModeAndGradedKind() throws Exception {
    add("a", "normal", 100, 1, T0, kind("vacuumLoss", true), kind("earthquake", false), kind("controllerFault", true));
    add("b", "normal", 100, 1, T0, kind("vacuumLoss", true), kind("bloom", true), kind("fuelContamination", false));
    add("c", "normal", 100, 1, T0, kind("vacuumLoss", false), kind("pumpTrip", true));
    add("d", "normal", 100, 1, T0, kind("vacuumLoss", true));
    add("h", "hard", 100, 1, T0, kind("vacuumLoss", false), kind("tsunami", true), kind("earthquake", true));

    Map<String, Row> stats = new HashMap<>();
    for (Row r : stats()) {
      stats.put(r.getField("mode") + "|" + r.getField("kind"), r);
    }
    assertEquals(Set.of("normal|vacuumLoss", "normal|fuelContamination", "normal|pumpTrip", "hard|vacuumLoss", "hard|tsunami"),
        stats.keySet());
    assertCounts(stats.get("normal|vacuumLoss"), 4, 3);
    assertCounts(stats.get("hard|vacuumLoss"), 1, 0);
    assertCounts(stats.get("normal|fuelContamination"), 1, 0);
    assertCounts(stats.get("hard|tsunami"), 1, 1);
    assertCounts(stats.get("normal|pumpTrip"), 1, 1);
  }

  @Test
  void anUpsertReplacesARunsStats() throws Exception {
    add("a", "normal", 100, 1, T0, kind("vacuumLoss", false));
    upsert("a", "normal", 200, 2, T0, kind("vacuumLoss", true));
    List<Row> stats = stats();
    assertEquals(1, stats.size());
    assertCounts(stats.get(0), 1, 1);
  }

  @Test
  void onlineCountsDistinctGamesInHoppingWindows() {
    add("a", "normal", 100, 1, T0);
    StreamTableEnvironment t = tables();
    Table online = LeaderboardSql.queries(t).online;
    assertEquals(List.of("window_start", "window_end", "online"), online.getResolvedSchema().getColumnNames());
    // Planning proves the HOP window runs on the processing-time attribute.
    String plan = online.explain();
    assertTrue(plan.contains("HOP"), plan);
  }

  @Test
  void theRunsTableSkipsUnparsableRecords() {
    StreamTableEnvironment t = StreamTableEnvironment.create(StreamExecutionEnvironment.getExecutionEnvironment());
    LeaderboardSql.kafkaTables(t, "localhost:9092", "");
    StringBuilder ddl = new StringBuilder();
    try (CloseableIterator<Row> it = t.executeSql("SHOW CREATE TABLE runs").collect()) {
      it.forEachRemaining(r -> ddl.append(r.getField(0)));
    } catch (Exception e) {
      throw new AssertionError(e);
    }
    assertTrue(ddl.toString().contains("'value.json.ignore-parse-errors' = 'true'"), ddl.toString());
  }

  // --- helpers ---

  private void assertCounts(Row r, long operators, long firstWell) {
    assertEquals(operators, ((Number) r.getField("operators")).longValue(), r.toString());
    assertEquals(firstWell, ((Number) r.getField("firstWell")).longValue(), r.toString());
  }

  private static Row kind(String kind, boolean firstHandledWell) {
    return Row.of(kind, 1, firstHandledWell ? 1 : 0, 3.0, firstHandledWell);
  }

  private void add(String runId, String mode, double water, int shifts, long endedAt, Row... kinds) {
    runs.add(Row.ofKind(RowKind.INSERT, runId, "Call-" + runId, mode, endedAt, shifts, water, "quit", kinds));
  }

  private void upsert(String runId, String mode, double water, int shifts, long endedAt, Row... kinds) {
    runs.add(Row.ofKind(RowKind.UPDATE_AFTER, runId, "Call-" + runId, mode, endedAt, shifts, water, "quit", kinds));
  }

  private StreamTableEnvironment tables() {
    StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
    env.setParallelism(1);
    StreamTableEnvironment t = StreamTableEnvironment.create(env);
    t.createTemporaryView("runs", t.fromChangelogStream(
        env.fromData(runs, RUN), Schema.newBuilder().primaryKey("runId").build(), ChangelogMode.upsert()));
    t.createTemporaryView("status", t.fromDataStream(
        env.fromData(List.of(Row.of("g1")), Types.ROW_NAMED(new String[] {"gameId"}, Types.STRING)),
        Schema.newBuilder().columnByExpression("pt", "PROCTIME()").build()));
    return t;
  }

  private List<Row> ranked() throws Exception {
    List<Row> rows = materialize(LeaderboardSql.queries(tables()).ranked);
    rows.sort(Comparator.comparing((Row r) -> (String) r.getField("mode"))
        .thenComparingLong(r -> ((Number) r.getField("rn")).longValue()));
    return rows;
  }

  private List<Row> stats() throws Exception {
    return materialize(LeaderboardSql.queries(tables()).stats);
  }

  /** Runs the (bounded) query and replays its changelog: adds insert, retractions remove. */
  private static List<Row> materialize(Table table) throws Exception {
    List<Row> rows = new ArrayList<>();
    try (CloseableIterator<Row> it = table.execute().collect()) {
      while (it.hasNext()) {
        Row change = it.next();
        RowKind kind = change.getKind();
        Row row = Row.copy(change);
        row.setKind(RowKind.INSERT);
        if (kind == RowKind.INSERT || kind == RowKind.UPDATE_AFTER) {
          rows.add(row);
        } else {
          assertTrue(rows.remove(row), "retraction of a row that is not there: " + change);
        }
      }
    }
    return rows;
  }

  private static List<String> runIds(List<Row> rows) {
    List<String> out = new ArrayList<>();
    rows.forEach(r -> out.add((String) r.getField("runId")));
    return out;
  }
}
