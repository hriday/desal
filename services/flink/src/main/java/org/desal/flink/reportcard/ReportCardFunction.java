package org.desal.flink.reportcard;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import org.apache.flink.api.common.functions.OpenContext;
import org.apache.flink.api.common.state.StateTtlConfig;
import org.apache.flink.api.common.state.ValueState;
import org.apache.flink.api.common.state.ValueStateDescriptor;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.streaming.api.functions.co.KeyedCoProcessFunction;
import org.apache.flink.util.Collector;
import org.apache.flink.util.OutputTag;
import org.desal.flink.common.Json;
import org.desal.flink.model.EventLine;
import org.desal.flink.model.RunResult;
import org.desal.flink.model.ShiftReport;

/**
 * Joins one game's {@code plant.events} (input 1) and {@code plant.status} (input 2) and writes a
 * {@link ShiftReport} for every finished shift (main output) and a {@link RunResult} when the game
 * ends (side output {@link #RUN_RESULTS}).
 *
 * <p>A KeyedCoProcessFunction runs on two streams that were connected and keyed by the same key
 * (here the gameId): records of both inputs with the same key reach the same instance, and the
 * keyed state it reads is that key's own. Flink orders records only within one input and reads the
 * two inputs independently. Ordering inside a game comes from the records' {@code epoch},
 * {@code seq} and {@code tick}, never from watermarks (docs/streaming-notes.md, "Event time").
 *
 * <p>Alignment. While the job catches up a backlog (after a restore or a redeploy) the sparse
 * events input runs shifts ahead of status (a shift is a few dozen events but 720 statuses). So
 * events are not applied when they arrive: they wait in a per-game buffer, in (epoch, tick, seq)
 * order, until a status of their epoch has reached their tick. A status at tick t first releases
 * the buffered events up to t, then is applied, which is the simulator's own order (each step
 * writes its events, then its status). If a game's status stops (it stalled, or the job never
 * sees it) the buffer is flushed after {@link #PENDING_END_TIMEOUT_MS} without progress.
 *
 * <p>De-duplication follows the streaming-notes contract. Host events ({@code host: true}) are
 * dropped. A record of an older epoch than the state's is stale and dropped. A newer epoch means
 * the simulator restored the game from a snapshot: the state forgets what came after the snapshot
 * tick and takes the new epoch's records as the truth (spec §4.3). Within an epoch an event whose
 * seq is not above the last one accepted is a resend; a status older than the last one is stale
 * (an equal tick is the clock standing still in handover or pause, and is applied).
 */
public class ReportCardFunction extends KeyedCoProcessFunction<String, Input, Input, ReportCardFunction.ShiftReportOut> {
  /** Side output: one result per finished run. */
  public static final OutputTag<RunResult> RUN_RESULTS = new OutputTag<>("run-results", TypeInformation.of(RunResult.class));

  /** A game's state is dropped after a week without records (a game that vanished without gameEnd). */
  public static final Duration STATE_TTL = Duration.ofDays(7);

  /**
   * How long buffered events wait without progress (no status applied for the game) before they
   * are applied anyway, so a game whose status stream stalls never holds its events forever.
   */
  public static final long PENDING_END_TIMEOUT_MS = 15_000;

  /** One shift report and the game it belongs to (the Kafka key of {@code shift.reports}). */
  public static class ShiftReportOut {
    public String gameId;
    public ShiftReport report;

    public ShiftReportOut() {}

    public ShiftReportOut(String gameId, ShiftReport report) {
      this.gameId = gameId;
      this.report = report;
    }
  }

  /**
   * Keyed state: a ValueState holds one value per key, so {@code game.value()} is the current
   * gameId's GameState. Flink stores it in the state backend and includes it in every checkpoint
   * (and savepoint), so a restarted job resumes each game where it left off.
   */
  private transient ValueState<GameState> game;

  @Override
  public void open(OpenContext openContext) {
    ValueStateDescriptor<GameState> descriptor = new ValueStateDescriptor<>("game", GameState.class);
    // State TTL: Flink expires a key's state once it has not been written for STATE_TTL, so games
    // that never sent gameEnd (lost with the simulator) do not pile up. Every record that changes
    // the state writes it, which restarts the clock; expired state is never handed back.
    descriptor.enableTimeToLive(StateTtlConfig.newBuilder(STATE_TTL)
        .setUpdateType(StateTtlConfig.UpdateType.OnCreateAndWrite)
        .setStateVisibility(StateTtlConfig.StateVisibility.NeverReturnExpired)
        .build());
    game = getRuntimeContext().getState(descriptor);
  }

  /** Input 1: plant.events. Filters, buffers, and releases what status has already covered. */
  @Override
  public void processElement1(Input in, Context ctx, Collector<ShiftReportOut> out) throws Exception {
    JsonNode e = Json.MAPPER.readTree(in.json);
    if (e.path("host").asBoolean(false)) {
      return; // host events are not part of the game's seq order and never move its marks
    }
    GameState g = load();
    if (g.ended) {
      return;
    }
    GameState.BufferedEvent b = new GameState.BufferedEvent();
    b.json = in.json;
    b.type = e.path("type").asText();
    b.epoch = e.path("epoch").asInt();
    b.tick = e.path("tick").asLong();
    b.seq = e.path("seq").asLong();
    b.timestamp = in.timestamp;
    if (b.epoch < g.epoch || b.epoch < g.bufferedEpoch) {
      return; // stale: a newer epoch has been seen
    }
    if (b.epoch == g.bufferedEpoch && b.seq <= g.lastSeq) {
      return; // a resend
    }
    if (b.epoch > g.bufferedEpoch) {
      // The first event of a newer epoch: buffered events of older epochs after the snapshot will
      // be replayed by the new epoch, so they are dropped (spec §4.3).
      dropAfterSnapshot(g, b.epoch, snapshotTick(b));
      g.bufferedEpoch = b.epoch;
    }
    g.lastSeq = b.seq;
    if (g.buffer.isEmpty()) {
      armFlushTimer(g, ctx);
    }
    insert(g.buffer, b);
    // Status may already be ahead of this event (normal play, or status read first).
    releaseUpTo(g, g.lastStatusTick, ctx, out);
    if (g.ended) {
      g.buffer.clear();
    }
    game.update(g);
  }

  /** Input 2: plant.status. Releases the events up to its tick, then is applied. */
  @Override
  public void processElement2(Input in, Context ctx, Collector<ShiftReportOut> out) throws Exception {
    JsonNode node = Json.MAPPER.readTree(in.json);
    StatusView s = StatusView.from(node);
    GameState g = load();
    if (g.ended || s.epoch < g.epoch) {
      return;
    }
    if (s.epoch > g.epoch) {
      // A running game's first status after a restore is the tick after the snapshot; a paused or
      // handover game re-sends status stamped at the snapshot tick itself. A buffered event of the
      // new epoch may say the snapshot is earlier still.
      long r = "running".equals(s.phase) ? s.tick - 1 : s.tick;
      for (GameState.BufferedEvent b : g.buffer) {
        if (b.epoch == s.epoch) {
          r = Math.min(r, snapshotTick(b));
          break;
        }
      }
      // Older-epoch events after the snapshot are replayed by the new epoch; the rest are in the
      // snapshot and are applied now, as their own epoch's statuses can no longer come.
      dropAfterSnapshot(g, s.epoch, r);
      while (!g.buffer.isEmpty() && g.buffer.get(0).epoch < s.epoch && !g.ended) {
        apply(g, g.buffer.remove(0), ctx, out);
      }
      if (g.ended) {
        finishEnded(g);
        return;
      }
      rewind(g, s.epoch, r);
    } else if (s.tick < g.lastStatusTick) {
      return;
    }
    releaseUpTo(g, s.tick, ctx, out);
    if (g.ended) {
      finishEnded(g);
      return;
    }
    g.lastStatusTick = s.tick;
    g.lastProgressAt = ctx.timerService().currentProcessingTime();
    if (g.callSign == null) {
      // gameStart not seen (the job started reading mid-game): status carries the same names.
      g.callSign = text(node, "callSign", null);
      g.mode = s.mode;
    }
    g.lastStatus = s;
    if (g.shift != null && (s.shiftId == null || s.shiftId == g.shift.shiftId)) {
      g.shift.onStatus(s);
    }
    game.update(g);
  }

  /**
   * The flush timer: if there has been no progress for {@link #PENDING_END_TIMEOUT_MS}, applies
   * every buffered event in order; otherwise waits again from the last progress.
   */
  @Override
  public void onTimer(long timestamp, OnTimerContext ctx, Collector<ShiftReportOut> out) throws Exception {
    GameState g = game.value();
    if (g == null || g.buffer.isEmpty()) {
      return;
    }
    long due = g.lastProgressAt + PENDING_END_TIMEOUT_MS;
    if (due > timestamp) {
      ctx.timerService().registerProcessingTimeTimer(due);
      return;
    }
    while (!g.buffer.isEmpty() && !g.ended) {
      apply(g, g.buffer.remove(0), ctx, out);
    }
    if (g.ended) {
      finishEnded(g);
      return;
    }
    game.update(g);
  }

  private GameState load() throws Exception {
    GameState g = game.value();
    return g == null ? new GameState() : g;
  }

  /**
   * Processing-time timer (first use): {@code registerProcessingTimeTimer(t)} makes Flink call
   * {@link #onTimer} for this key once the machine's clock reaches {@code t}. Timers are kept with
   * the keyed state, checkpoints included. Armed when the buffer fills from empty; a status applied
   * since then counts as progress and pushes the flush back (see onTimer), so a catch-up that is
   * still moving is never flushed early.
   */
  private static void armFlushTimer(GameState g, Context ctx) {
    g.lastProgressAt = ctx.timerService().currentProcessingTime();
    ctx.timerService().registerProcessingTimeTimer(g.lastProgressAt + PENDING_END_TIMEOUT_MS);
  }

  /** Applies the buffered events of the state's epoch with a tick up to {@code tick}, in order. */
  private void releaseUpTo(GameState g, long tick, Context ctx, Collector<ShiftReportOut> out) throws Exception {
    while (!g.buffer.isEmpty() && !g.ended) {
      GameState.BufferedEvent b = g.buffer.get(0);
      if (b.epoch != g.epoch || b.tick > tick) {
        return;
      }
      apply(g, g.buffer.remove(0), ctx, out);
    }
  }

  /** After gameEnd nothing else counts: drop what is buffered and save. */
  private void finishEnded(GameState g) throws Exception {
    g.buffer.clear();
    game.update(g);
  }

  /** Inserts {@code b} keeping the buffer in (epoch, tick, seq) order. */
  private static void insert(List<GameState.BufferedEvent> buffer, GameState.BufferedEvent b) {
    int i = buffer.size();
    while (i > 0 && after(buffer.get(i - 1), b)) {
      i--;
    }
    buffer.add(i, b);
  }

  private static boolean after(GameState.BufferedEvent a, GameState.BufferedEvent b) {
    if (a.epoch != b.epoch) {
      return a.epoch > b.epoch;
    }
    if (a.tick != b.tick) {
      return a.tick > b.tick;
    }
    return a.seq > b.seq;
  }

  /** Drops buffered events of epochs older than {@code epoch} that came after the snapshot tick. */
  private static void dropAfterSnapshot(GameState g, int epoch, long snapshotTick) {
    g.buffer.removeIf(x -> x.epoch < epoch && x.tick > snapshotTick);
  }

  /**
   * The snapshot tick implied by the first event of a new epoch. Every tick that emits an event is
   * snapshotted, so that event normally comes after the snapshot tick: the snapshot is at tick - 1
   * at the latest. commandRejected is the exception: a paused game emits it without stepping, at
   * the snapshot tick itself.
   */
  private static long snapshotTick(GameState.BufferedEvent b) {
    return "commandRejected".equals(b.type) ? b.tick : b.tick - 1;
  }

  /** Today's event handling, run on an event once status has caught up with it. */
  private void apply(GameState g, GameState.BufferedEvent b, Context ctx, Collector<ShiftReportOut> out)
      throws Exception {
    if (b.epoch < g.epoch) {
      return; // stale (its epoch was superseded while it waited)
    }
    if (b.epoch > g.epoch) {
      rewind(g, b.epoch, snapshotTick(b)); // the status of the new epoch never came first
    }
    JsonNode e = Json.MAPPER.readTree(b.json);
    long tick = b.tick;
    switch (b.type) {
      case "gameStart":
        g.callSign = text(e, "callSign", g.callSign);
        g.mode = text(e, "mode", "normal");
        break;
      case "shiftStart":
        g.shift = new ShiftTracker();
        g.shift.onShiftStart(tick, e.path("shiftId").asInt(), e.path("target").path("productM3").asDouble());
        break;
      case "scenario":
        if (g.shift != null) {
          g.shift.onScenario(e.path("eventId").asInt(), e.path("kind").asText(), tick, g.lastStatus);
        }
        break;
      case "eventCleared":
        if (g.shift != null) {
          g.shift.onCleared(e.path("eventId").asInt(), text(e, "how", null), tick);
        }
        break;
      case "shiftEnd":
        g.runId = text(e, "runId", g.runId);
        // A shift whose shiftStart the job never saw (it started reading mid-shift) gets no report.
        if (g.shift != null && g.shift.shiftId == e.path("shiftId").asInt()) {
          ShiftReport report = g.shift.finish(e.path("summary"), g.history, g.mode);
          report.epoch = g.epoch;
          out.collect(new ShiftReportOut(ctx.getCurrentKey(), report));
          g.history.add(report.self);
          fold(g, report.events);
          g.shift = null;
        }
        break;
      case "gameEnd":
        endGame(g, e, b.timestamp, ctx);
        break;
      default:
        break;
    }
  }

  /**
   * The game was restored from the snapshot taken at {@code snapshotTick}: the new epoch replays
   * everything after it, so forget that. A shift that started after the snapshot starts again, so
   * its tracker is dropped. (Buffered events after the snapshot were dropped by the caller.)
   */
  private static void rewind(GameState g, int epoch, long snapshotTick) {
    g.epoch = epoch;
    g.lastStatusTick = Math.min(g.lastStatusTick, snapshotTick);
    if (g.shift != null && g.shift.startTick > snapshotTick) {
      g.shift = null;
    }
    if (g.shift != null) {
      g.shift.rewindTo(snapshotTick);
    }
    if (g.lastStatus != null && g.lastStatus.tick > snapshotTick) {
      g.lastStatus = null;
    }
  }

  /**
   * Adds one shift's events to the run's per-kind stats. Only graded kinds count, plus earthquake,
   * which is counted but never handled well (it has no verdict). {@code firstHandledWell} is set
   * when a kind first occurs in the run.
   */
  private static void fold(GameState g, List<EventLine> lines) {
    for (EventLine line : lines) {
      boolean graded = Rules.hasVerdict(line.kind);
      if (!graded && !"earthquake".equals(line.kind)) {
        continue;
      }
      boolean well = "quick".equals(line.verdict) || "ok".equals(line.verdict);
      GameState.KindTally t = g.kinds.get(line.kind);
      if (t == null) {
        t = new GameState.KindTally();
        t.kind = line.kind;
        t.firstHandledWell = well;
        g.kinds.put(line.kind, t);
      }
      t.count++;
      if (well) {
        t.handledWell++;
      }
      if (graded && line.responseMinutes != null) {
        t.responseMinutesSum += line.responseMinutes;
        t.responses++;
      }
    }
  }

  /**
   * gameEnd: a shift still open counts toward the run's stats (it gets no report), and the run's
   * result goes to the side output. Without a runId (never the case on Kafka) there is nothing to
   * key the result by, so none is written.
   */
  private static void endGame(GameState g, JsonNode e, long timestamp, Context ctx) {
    if (g.shift != null) {
      fold(g, g.shift.lines());
      g.shift = null;
    }
    g.runId = text(e, "runId", g.runId);
    g.callSign = text(e, "callSign", g.callSign);
    // gameEnd carries the mode too: the job's first records for a game may be its gameEnd, so a
    // Hard run must not fall back to the "normal" default and land on the Normal board.
    g.mode = text(e, "mode", g.mode);
    g.ended = true;
    if (g.runId == null) {
      return;
    }
    RunResult r = new RunResult();
    r.runId = g.runId;
    r.callSign = g.callSign;
    r.mode = g.mode;
    r.endedAt = timestamp;
    r.shiftsCompleted = e.path("score").path("shiftsCompleted").asInt();
    r.totalProductM3 = e.path("score").path("totalProductM3").asDouble();
    r.endReason = text(e, "reason", "error");
    List<GameState.KindTally> tallies = new ArrayList<>(g.kinds.values());
    tallies.sort(Comparator.comparing(t -> t.kind));
    r.kinds = new ArrayList<>();
    for (GameState.KindTally t : tallies) {
      r.kinds.add(t.toKindStat());
    }
    ctx.output(RUN_RESULTS, r);
  }

  private static String text(JsonNode node, String field, String fallback) {
    JsonNode v = node.path(field);
    return v.isTextual() ? v.asText() : fallback;
  }
}
