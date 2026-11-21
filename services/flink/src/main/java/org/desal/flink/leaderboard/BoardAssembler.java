package org.desal.flink.leaderboard;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import org.apache.flink.api.common.functions.OpenContext;
import org.apache.flink.api.common.state.MapState;
import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.state.ValueState;
import org.apache.flink.api.common.state.ValueStateDescriptor;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.streaming.api.functions.KeyedProcessFunction;
import org.apache.flink.util.Collector;
import org.apache.flink.util.OutputTag;
import org.desal.flink.model.KindShare;
import org.desal.flink.model.Leaderboard;
import org.desal.flink.model.LeaderboardRow;
import org.desal.flink.model.ModeBoard;
import org.desal.flink.model.RunRank;

/**
 * Replays the three SQL changelogs into one copy of the ranking, the stats and the online count,
 * and every 5 s of processing time publishes one {@link Leaderboard} (both modes) plus a
 * {@link RunRank} for each run whose rank changed. Keyed by the constant "board", so all state
 * lives under one key on one task: there is one leaderboard.
 */
public class BoardAssembler extends KeyedProcessFunction<String, BoardInput, Leaderboard> {
  public static final OutputTag<RunRank> RANKS = new OutputTag<>("run-ranks", TypeInformation.of(RunRank.class));

  /** At most one board per 5 s. */
  public static final long EMIT_EVERY_MS = 5_000;
  /** A board at least every 60 s even when nothing changed, so "today" ages and updatedAt moves. */
  public static final long HEARTBEAT_MS = 60_000;
  /** No window result for 70 s means no plant sent a status in the last minute: online is 0. */
  public static final long ONLINE_STALE_MS = 70_000;
  public static final long TODAY_MS = 24L * 60 * 60 * 1000;
  public static final int BOARD_SIZE = 10;
  public static final String NORMAL = "normal";
  public static final String HARD = "hard";

  /** Best first: more water, then more shifts, then the earlier run (runId only to be deterministic). */
  static final Comparator<LeaderboardRow> ORDER = Comparator
      .comparingDouble((LeaderboardRow r) -> -r.totalProductM3)
      .thenComparing(r -> -r.shiftsCompleted)
      .thenComparingLong(r -> r.endedAt)
      .thenComparing(r -> r.runId);

  // Keyed state: values Flink keeps per key (here the one key "board"), stored in the state
  // backend and included in every checkpoint, so a restart resumes with the same ranking.
  /** "mode|runId" to the run's row; rank is its all-time rank in its mode, from the SQL Top-N. */
  private transient MapState<String, LeaderboardRow> runs;
  /** "mode|kind" to the operators who met the kind, and how many handled their first one well. */
  private transient MapState<String, Integer> operators;
  private transient MapState<String, Integer> firstWell;
  /** The latest online count and the processing time it arrived. */
  private transient ValueState<Integer> online;
  private transient ValueState<Long> onlineAt;
  /** runId to the rank last written to run.ranks. */
  private transient MapState<String, RunRank> lastRanks;
  private transient ValueState<Boolean> dirty;
  private transient ValueState<Long> lastEmitAt;
  private transient ValueState<Long> nextTimer;

  @Override
  public void open(OpenContext ctx) {
    runs = getRuntimeContext().getMapState(
        new MapStateDescriptor<>("runs", Types.STRING, TypeInformation.of(LeaderboardRow.class)));
    operators = getRuntimeContext().getMapState(new MapStateDescriptor<>("operators", Types.STRING, Types.INT));
    firstWell = getRuntimeContext().getMapState(new MapStateDescriptor<>("firstWell", Types.STRING, Types.INT));
    online = getRuntimeContext().getState(new ValueStateDescriptor<>("online", Types.INT));
    onlineAt = getRuntimeContext().getState(new ValueStateDescriptor<>("onlineAt", Types.LONG));
    lastRanks = getRuntimeContext().getMapState(
        new MapStateDescriptor<>("lastRanks", Types.STRING, TypeInformation.of(RunRank.class)));
    dirty = getRuntimeContext().getState(new ValueStateDescriptor<>("dirty", Types.BOOLEAN));
    lastEmitAt = getRuntimeContext().getState(new ValueStateDescriptor<>("lastEmitAt", Types.LONG));
    nextTimer = getRuntimeContext().getState(new ValueStateDescriptor<>("nextTimer", Types.LONG));
  }

  @Override
  public void processElement(BoardInput in, Context ctx, Collector<Leaderboard> out) throws Exception {
    long now = ctx.timerService().currentProcessingTime();
    switch (in.source) {
      case RANKED:
        applyRanked(in);
        break;
      case STATS:
        applyStat(in);
        break;
      case ONLINE:
        online.update(in.online);
        onlineAt.update(now);
        break;
      default:
        return;
    }
    dirty.update(true);
    if (nextTimer.value() == null) {
      schedule(ctx, now + EMIT_EVERY_MS);
    }
  }

  /**
   * A changelog retraction takes back one exact row, so it only removes the stored row when that
   * row is the one being taken back. The Top-N changelog can add a run's new rank before it takes
   * back the old one (a run moving up when one above it is deleted); blindly deleting by runId
   * would then lose the run.
   */
  private void applyRanked(BoardInput in) throws Exception {
    String key = in.mode + "|" + in.runId;
    if (in.retract) {
      LeaderboardRow have = runs.get(key);
      if (have != null && have.rank == in.rank && have.totalProductM3 == in.totalProductM3
          && have.shiftsCompleted == in.shiftsCompleted && have.endedAt == in.endedAt) {
        runs.remove(key);
      }
      return;
    }
    LeaderboardRow row = new LeaderboardRow();
    row.rank = in.rank;
    row.runId = in.runId;
    row.callSign = in.callSign;
    row.shiftsCompleted = in.shiftsCompleted;
    row.totalProductM3 = in.totalProductM3;
    row.endedAt = in.endedAt;
    runs.put(key, row);
  }

  private void applyStat(BoardInput in) throws Exception {
    String key = in.mode + "|" + in.kind;
    if (in.retract) {
      if (Objects.equals(operators.get(key), in.operators) && Objects.equals(firstWell.get(key), in.firstWell)) {
        operators.remove(key);
        firstWell.remove(key);
      }
      return;
    }
    operators.put(key, in.operators);
    firstWell.put(key, in.firstWell);
  }

  private void schedule(Context ctx, long at) throws Exception {
    ctx.timerService().registerProcessingTimeTimer(at);
    nextTimer.update(at);
  }

  /**
   * Fires every 5 s of processing time once the first input has arrived (timers are kept in
   * checkpoints too, so the cycle survives a restart). Publishes when an input changed, when the
   * online count has just gone stale, or when the last board is 60 s old.
   */
  @Override
  public void onTimer(long now, OnTimerContext ctx, Collector<Leaderboard> out) throws Exception {
    schedule(ctx, now + EMIT_EVERY_MS);
    Long last = lastEmitAt.value();
    Long seen = onlineAt.value();
    boolean wentStale = seen != null && last != null && last - seen < ONLINE_STALE_MS && now - seen >= ONLINE_STALE_MS;
    if (!Boolean.TRUE.equals(dirty.value()) && last != null && now - last < HEARTBEAT_MS && !wentStale) {
      return;
    }
    emit(now, ctx, out);
    dirty.update(false);
    lastEmitAt.update(now);
  }

  private void emit(long now, OnTimerContext ctx, Collector<Leaderboard> out) throws Exception {
    Map<String, List<LeaderboardRow>> byMode = new HashMap<>();
    for (Map.Entry<String, LeaderboardRow> e : runs.entries()) {
      String mode = e.getKey().substring(0, e.getKey().indexOf('|'));
      byMode.computeIfAbsent(mode, m -> new ArrayList<>()).add(e.getValue());
    }

    Leaderboard board = new Leaderboard();
    board.updatedAt = now;
    Long seen = onlineAt.value();
    board.online = seen == null || now - seen >= ONLINE_STALE_MS ? 0 : online.value();

    byMode.putIfAbsent(NORMAL, new ArrayList<>());
    byMode.putIfAbsent(HARD, new ArrayList<>());
    Set<String> present = new HashSet<>();
    Map<String, ModeBoard> boards = new HashMap<>();
    for (Map.Entry<String, List<LeaderboardRow>> e : byMode.entrySet()) {
      boards.put(e.getKey(), modeBoard(e.getKey(), e.getValue(), now, ctx, present));
    }
    board.normal = boards.get(NORMAL);
    board.hard = boards.get(HARD);

    // Runs that left the ranking (deleted, or beyond MAX_RANKED_RUNS) are forgotten.
    List<String> gone = new ArrayList<>();
    for (String runId : lastRanks.keys()) {
      if (!present.contains(runId)) {
        gone.add(runId);
      }
    }
    for (String runId : gone) {
      lastRanks.remove(runId);
    }
    out.collect(board);
  }

  /** One mode's board; also writes a RunRank for each of the mode's runs whose ranks changed. */
  private ModeBoard modeBoard(String mode, List<LeaderboardRow> rows, long now, OnTimerContext ctx,
      Set<String> present) throws Exception {
    List<LeaderboardRow> allTime = new ArrayList<>(rows);
    allTime.sort(Comparator.comparingInt(r -> r.rank));

    List<LeaderboardRow> today = new ArrayList<>();
    for (LeaderboardRow r : rows) {
      if (r.endedAt >= now - TODAY_MS) {
        today.add(r);
      }
    }
    today.sort(ORDER);
    Map<String, Integer> todayRank = new HashMap<>();
    for (int i = 0; i < today.size(); i++) {
      todayRank.put(today.get(i).runId, i + 1);
    }

    for (LeaderboardRow r : rows) {
      present.add(r.runId);
      RunRank rank = new RunRank();
      rank.runId = r.runId;
      rank.allTime = r.rank;
      rank.today = todayRank.get(r.runId);
      RunRank before = lastRanks.get(r.runId);
      if (before == null || before.allTime != rank.allTime || !Objects.equals(before.today, rank.today)) {
        lastRanks.put(r.runId, rank);
        ctx.output(RANKS, rank);
      }
    }

    ModeBoard board = new ModeBoard();
    board.allTime = new ArrayList<>(allTime.subList(0, Math.min(BOARD_SIZE, allTime.size())));
    board.today = new ArrayList<>();
    for (int i = 0; i < Math.min(BOARD_SIZE, today.size()); i++) {
      board.today.add(withRank(today.get(i), i + 1));
    }
    board.stats = stats(mode);
    return board;
  }

  private List<KindShare> stats(String mode) throws Exception {
    String prefix = mode + "|";
    List<KindShare> out = new ArrayList<>();
    for (Map.Entry<String, Integer> e : operators.entries()) {
      if (!e.getKey().startsWith(prefix) || e.getValue() <= 0) {
        continue;
      }
      KindShare s = new KindShare();
      s.kind = e.getKey().substring(prefix.length());
      s.operators = e.getValue();
      Integer well = firstWell.get(e.getKey());
      s.firstHandledWellPct = Math.round(1000.0 * (well == null ? 0 : well) / s.operators) / 10.0;
      out.add(s);
    }
    out.sort(Comparator.comparing(s -> s.kind));
    return out;
  }

  private static LeaderboardRow withRank(LeaderboardRow r, int rank) {
    LeaderboardRow copy = new LeaderboardRow();
    copy.rank = rank;
    copy.callSign = r.callSign;
    copy.shiftsCompleted = r.shiftsCompleted;
    copy.totalProductM3 = r.totalProductM3;
    copy.endedAt = r.endedAt;
    copy.runId = r.runId;
    return copy;
  }
}
