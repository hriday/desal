package org.desal.flink.leaderboard;

import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.datastream.SingleOutputStreamOperator;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.table.api.bridge.java.StreamTableEnvironment;
import org.desal.flink.common.Args;
import org.desal.flink.common.JsonSink;
import org.desal.flink.common.Topics;
import org.desal.flink.model.Leaderboard;
import org.desal.flink.model.RunRank;

/**
 * The "leaderboard" job: run.results and plant.status through Flink SQL, then one assembler, into
 * leaderboard (key "board") and run.ranks (keyed by runId). Options: {@code --brokers},
 * {@code --topic-suffix}.
 */
public final class LeaderboardJob {
  public static final String JOB_NAME = "leaderboard";
  public static final String BOARD_KEY = "board";
  public static final long CHECKPOINT_EVERY_MS = 60_000;

  private LeaderboardJob() {}

  public static void main(String[] argv) throws Exception {
    StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();
    define(env, Args.parse(argv));
    env.execute(JOB_NAME);
  }

  /** Adds the job's tables, queries, assembler and sinks to {@code env}. */
  public static void define(StreamExecutionEnvironment env, Args args) {
    // Checkpoints as in the report-card job. The SQL operators get their uids from the planner
    // (derived from the query's shape), so unlike that job this one cannot turn auto-generated
    // uids off: the DataStream operators below get fixed uids, and if a changed query no longer
    // matches a savepoint the job starts fresh and rebuilds from run.results (spec §4.6).
    env.enableCheckpointing(CHECKPOINT_EVERY_MS);
    env.setParallelism(1);
    StreamTableEnvironment t = StreamTableEnvironment.create(env);
    LeaderboardSql.kafkaTables(t, args.brokers, args.topicSuffix);
    LeaderboardSql.Queries q = LeaderboardSql.queries(t);

    // A changelog stream carries a table's changes as rows tagged with a RowKind: INSERT and
    // UPDATE_AFTER add a row, UPDATE_BEFORE and DELETE take one back. toChangelogStream hands the
    // three SQL results to the DataStream API in that form.
    TypeInformation<BoardInput> type = TypeInformation.of(BoardInput.class);
    DataStream<BoardInput> ranked = t.toChangelogStream(q.ranked)
        .map(BoardInput::fromRanked, type).uid("ranked-to-input").name("ranked");
    DataStream<BoardInput> stats = t.toChangelogStream(q.stats)
        .map(BoardInput::fromStats, type).uid("stats-to-input").name("stats");
    DataStream<BoardInput> online = t.toChangelogStream(q.online)
        .map(BoardInput::fromOnline, type).uid("online-to-input").name("online");

    SingleOutputStreamOperator<Leaderboard> boards = ranked
        .union(stats, online)
        .keyBy(x -> BOARD_KEY)
        .process(new BoardAssembler())
        .uid("board-assembler").name("board assembler");

    boards
        .sinkTo(JsonSink.<Leaderboard>of(args.brokers, args.topic(Topics.LEADERBOARD), b -> BOARD_KEY, b -> b))
        .uid("leaderboard-sink").name("leaderboard");
    boards.getSideOutput(BoardAssembler.RANKS)
        .sinkTo(JsonSink.<RunRank>of(args.brokers, args.topic(Topics.RUN_RANKS), r -> r.runId, r -> r))
        .uid("run-ranks-sink").name("run.ranks");
  }
}
