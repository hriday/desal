package org.desal.flink.leaderboard;

import org.apache.flink.table.api.Table;
import org.apache.flink.table.api.bridge.java.StreamTableEnvironment;
import org.desal.flink.common.Topics;

/**
 * The leaderboard's Flink SQL (spec §4.4): the two Kafka tables it reads and the three queries the
 * assembler turns into one board. Everything is per mode except the online count.
 */
public final class LeaderboardSql {
  /** Runs ranked per mode; enough for any player's "your rank", small enough to keep in state. */
  public static final int MAX_RANKED_RUNS = 100_000;

  /**
   * The kinds the board has stats for: the six sharp kinds and the two disasters graded on
   * time-to-clear. earthquake is only noted (no verdict), and the other kinds are not sharp.
   */
  public static final String GRADED_KINDS = "'pumpTrip', 'tubeLeak', 'vacuumLoss', 'powerDip', 'storm', "
      + "'sensorFailure', 'fuelContamination', 'tsunami'";

  private LeaderboardSql() {}

  /** The three results the assembler reads. Each is a changelog: rows are added and taken back. */
  public static final class Queries {
    public final Table ranked;
    public final Table stats;
    public final Table online;

    Queries(Table ranked, Table stats, Table online) {
      this.ranked = ranked;
      this.stats = stats;
      this.online = online;
    }
  }

  /** Registers {@code runs} (run.results) and {@code status} (plant.status) on Kafka. */
  public static void kafkaTables(StreamTableEnvironment t, String brokers, String suffix) {
    // An upsert table is a table whose rows are keyed by a primary key: a record for a key that is
    // already there replaces that row, and a record with no value (a tombstone) deletes it. That
    // is exactly what run.results is (one record per runId, the latest wins), so a run written
    // twice counts once. The upsert-kafka connector always reads the topic from the start, so the
    // leaderboard rebuilds itself from run.results whenever the job starts without state.
    t.executeSql("CREATE TABLE runs (\n"
        + "  runId STRING,\n"
        + "  callSign STRING,\n"
        + "  `mode` STRING,\n"
        + "  endedAt BIGINT,\n"
        + "  shiftsCompleted INT,\n"
        + "  totalProductM3 DOUBLE,\n"
        + "  endReason STRING,\n"
        + "  kinds ARRAY<ROW<kind STRING, `count` INT, handledWell INT, meanResponseMinutes DOUBLE,"
        + " firstHandledWell BOOLEAN>>,\n"
        + "  PRIMARY KEY (runId) NOT ENFORCED\n"
        + ") WITH (\n"
        + "  'connector' = 'upsert-kafka',\n"
        + "  'topic' = '" + Topics.name(Topics.RUN_RESULTS, suffix) + "',\n"
        + "  'properties.bootstrap.servers' = '" + brokers + "',\n"
        + "  'key.format' = 'raw',\n"
        + "  'value.format' = 'json'\n"
        + ")");
    // plant.status is read as a plain append-only stream. Only gameId is needed; the JSON format
    // skips every other field, and a record it cannot parse is dropped instead of failing the job.
    // pt is a processing-time attribute: the wall-clock time at which Flink handles the record.
    // "Online now" is about now, so the window below runs on it rather than on a time in the record.
    t.executeSql("CREATE TABLE status (\n"
        + "  gameId STRING,\n"
        + "  pt AS PROCTIME()\n"
        + ") WITH (\n"
        + "  'connector' = 'kafka',\n"
        + "  'topic' = '" + Topics.name(Topics.STATUS, suffix) + "',\n"
        + "  'properties.bootstrap.servers' = '" + brokers + "',\n"
        + "  'scan.startup.mode' = 'latest-offset',\n"
        + "  'format' = 'json',\n"
        + "  'json.ignore-parse-errors' = 'true'\n"
        + ")");
  }

  /** The three queries, over whatever tables are registered as {@code runs} and {@code status}. */
  public static Queries queries(StreamTableEnvironment t) {
    // Top-N: ROW_NUMBER() over a partition, filtered to the first N rows, is how Flink SQL keeps a
    // continuously updated ranking. Flink holds each mode's top MAX_RANKED_RUNS in state; when a
    // run arrives (or an upsert changes one), every row whose position moves is updated. The
    // result is a changelog rather than a list: each change takes back the old (run, rn) row and
    // adds the new one, which the assembler replays into its own copy of the ranking.
    Table ranked = t.sqlQuery("SELECT runId, callSign, `mode`, shiftsCompleted, totalProductM3, endedAt, rn\n"
        + "FROM (\n"
        + "  SELECT runId, callSign, `mode`, shiftsCompleted, totalProductM3, endedAt,\n"
        + "    ROW_NUMBER() OVER (PARTITION BY `mode`\n"
        + "      ORDER BY totalProductM3 DESC, shiftsCompleted DESC, endedAt ASC) AS rn\n"
        + "  FROM runs\n"
        + ")\n"
        + "WHERE rn <= " + MAX_RANKED_RUNS);

    // One row per run and kind it met, counted per mode. Because runs is an upsert table, a
    // replaced run takes its old kinds back out of the counts before adding the new ones.
    Table stats = t.sqlQuery("SELECT r.`mode`, k.kind, COUNT(*) AS operators,\n"
        + "  SUM(CASE WHEN k.firstHandledWell THEN 1 ELSE 0 END) AS firstWell\n"
        + "FROM runs AS r\n"
        + "CROSS JOIN UNNEST(r.kinds) AS k (kind, `count`, handledWell, meanResponseMinutes, firstHandledWell)\n"
        + "WHERE k.kind IN (" + GRADED_KINDS + ")\n"
        + "GROUP BY r.`mode`, k.kind");

    // A HOP (sliding) window: every 5 s, a window covering the last 60 s closes, and the count of
    // distinct gameIds that sent a status in it is emitted once. Windows are on processing time
    // (pt), so a window closes by the clock even if no more records arrive; a window with no
    // records emits nothing, which is why the assembler treats an old count as zero. Only the
    // count leaves the query, never the gameIds. Both modes are counted together.
    Table online = t.sqlQuery("SELECT window_start, window_end, COUNT(DISTINCT gameId) AS online\n"
        + "FROM TABLE(HOP(TABLE status, DESCRIPTOR(pt), INTERVAL '5' SECOND, INTERVAL '60' SECOND))\n"
        + "GROUP BY window_start, window_end");

    return new Queries(ranked, stats, online);
  }
}
