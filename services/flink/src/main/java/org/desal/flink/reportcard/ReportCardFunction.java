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
 * keyed state it reads is that key's own. Flink orders records only within one input; across the
 * two inputs a status may arrive before or after the events of its tick, which ShiftTracker allows
 * for. Ordering inside a game comes from the records' {@code epoch}, {@code seq} and {@code tick},
 * never from watermarks (docs/streaming-notes.md, "Event time").
 *
 * <p>De-duplication follows the streaming-notes contract. Host events ({@code host: true}) are
 * dropped. A record of an older epoch than the state's is stale and dropped. A newer epoch means
 * the simulator restored the game from a snapshot: the state forgets what came after the snapshot
 * tick and takes the new epoch's records as the truth (spec §4.3). Within an epoch an event whose
 * seq is not above the last one applied is a resend; a status older than the last one is stale (an
 * equal tick is the clock standing still in handover or pause, and is applied).
 */
public class ReportCardFunction extends KeyedCoProcessFunction<String, Input, Input, ReportCardFunction.ShiftReportOut> {
  /** Side output: one result per finished run. */
  public static final OutputTag<RunResult> RUN_RESULTS = new OutputTag<>("run-results", TypeInformation.of(RunResult.class));

  /** A game's state is dropped after a week without records (a game that vanished without gameEnd). */
  public static final Duration STATE_TTL = Duration.ofDays(7);

  /** How long a shiftEnd or gameEnd waits for status to catch up before it is finished anyway. */
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

  /** Input 1: plant.events. */
  @Override
  public void processElement1(Input in, Context ctx, Collector<ShiftReportOut> out) throws Exception {
    JsonNode e = Json.MAPPER.readTree(in.json);
    if (e.path("host").asBoolean(false)) {
      return; // host events are not part of the game's seq order and never move its marks
    }
    GameState g = load();
    if (g.ended || g.pendingGameEnd != null) {
      return; // nothing follows a gameEnd; only its catching-up statuses still count
    }
    int epoch = e.path("epoch").asInt();
    long seq = e.path("seq").asLong();
    long tick = e.path("tick").asLong();
    String type = e.path("type").asText();
    if (epoch < g.epoch) {
      return;
    }
    if (epoch > g.epoch) {
      // Every tick that emits an event is snapshotted, so the first event of a new epoch normally
      // comes after the snapshot tick: the snapshot is at tick - 1 at the latest. commandRejected
      // is the exception: a paused game emits it without stepping, at the snapshot tick itself.
      rewind(g, epoch, "commandRejected".equals(type) ? tick : tick - 1, ctx, out);
      if (g.ended) {
        game.update(g);
        return;
      }
    } else if (seq <= g.lastSeq) {
      return;
    }
    g.lastSeq = seq;

    switch (type) {
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
          if (g.pendingShiftEnd != null) {
            finishShift(g, ctx.getCurrentKey(), out); // one pending shift at a time
          }
          // Hold the end until status reaches its tick (see holdEnd). The next shift may start
          // meanwhile, so the ending shift keeps its own tracker.
          g.ending = g.shift;
          g.shift = null;
          g.pendingShiftEnd = holdEnd(in, epoch, tick, ctx);
          if (g.lastStatusTick >= tick) {
            finishShift(g, ctx.getCurrentKey(), out);
          }
        }
        break;
      case "gameEnd":
        g.pendingGameEnd = holdEnd(in, epoch, tick, ctx);
        if (g.lastStatusTick >= tick) {
          finishGame(g, ctx, out);
        }
        break;
      default:
        break;
    }
    game.update(g);
  }

  /** Input 2: plant.status. */
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
      // handover game re-sends status stamped at the snapshot tick itself.
      rewind(g, s.epoch, "running".equals(s.phase) ? s.tick - 1 : s.tick, ctx, out);
      if (g.ended) {
        game.update(g);
        return;
      }
    } else if (s.tick < g.lastStatusTick) {
      return;
    }
    g.lastStatusTick = s.tick;
    if (g.callSign == null) {
      // gameStart not seen (the job started reading mid-game): status carries the same names.
      g.callSign = text(node, "callSign", null);
      g.mode = s.mode;
    }
    g.lastStatus = s;
    // A status up to a pending shiftEnd's tick still belongs to the shift it ends.
    if (g.pendingShiftEnd != null && s.tick <= g.pendingShiftEnd.tick) {
      feed(g.ending, s);
    }
    feed(g.shift, s);
    if (g.pendingShiftEnd != null && s.tick >= g.pendingShiftEnd.tick) {
      finishShift(g, ctx.getCurrentKey(), out);
    }
    if (g.pendingGameEnd != null && s.tick >= g.pendingGameEnd.tick) {
      finishGame(g, ctx, out);
    }
    game.update(g);
  }

  /** The fallback for an end record whose status never caught up: finish with what the job has. */
  @Override
  public void onTimer(long timestamp, OnTimerContext ctx, Collector<ShiftReportOut> out) throws Exception {
    GameState g = game.value();
    if (g == null) {
      return;
    }
    if (g.pendingShiftEnd != null && g.pendingShiftEnd.deadline <= timestamp) {
      finishShift(g, ctx.getCurrentKey(), out);
    }
    if (g.pendingGameEnd != null && g.pendingGameEnd.deadline <= timestamp) {
      finishGame(g, ctx, out);
    }
    game.update(g);
  }

  private GameState load() throws Exception {
    GameState g = game.value();
    return g == null ? new GameState() : g;
  }

  /**
   * Holds an end record until a status of its epoch with a tick at or after it has been applied.
   * The two inputs are read independently: while the job catches up a backlog (after a restore or
   * a redeploy), the sparse events input runs far ahead of status, and finishing a shift on its
   * shiftEnd would drop the statuses still to come (responses missed, pace hours lost).
   *
   * <p>Processing-time timer (first use): {@code registerProcessingTimeTimer(t)} makes Flink call
   * {@link #onTimer} for this key once the machine's clock reaches {@code t}. Timers are kept with
   * the keyed state, checkpoints included. This one is the fallback: if no such status arrives
   * within {@link #PENDING_END_TIMEOUT_MS}, the end is finished with what the job has.
   */
  private static GameState.PendingEnd holdEnd(Input in, int epoch, long tick, Context ctx) {
    GameState.PendingEnd p = new GameState.PendingEnd();
    p.json = in.json;
    p.epoch = epoch;
    p.tick = tick;
    p.timestamp = in.timestamp;
    p.deadline = ctx.timerService().currentProcessingTime() + PENDING_END_TIMEOUT_MS;
    ctx.timerService().registerProcessingTimeTimer(p.deadline);
    return p;
  }

  /** Emits the pending shift's report and adds it to the run (once per held shiftEnd). */
  private static void finishShift(GameState g, String gameId, Collector<ShiftReportOut> out) throws Exception {
    JsonNode e = Json.MAPPER.readTree(g.pendingShiftEnd.json);
    ShiftReport report = g.ending.finish(e.path("summary"), g.history, g.mode);
    report.epoch = g.pendingShiftEnd.epoch;
    out.collect(new ShiftReportOut(gameId, report));
    g.history.add(report.self);
    fold(g, report.events);
    g.ending = null;
    g.pendingShiftEnd = null;
  }

  /** Finishes a pending shiftEnd first (it came before the gameEnd), then ends the game. */
  private static void finishGame(GameState g, Context ctx, Collector<ShiftReportOut> out) throws Exception {
    if (g.pendingShiftEnd != null) {
      finishShift(g, ctx.getCurrentKey(), out);
    }
    GameState.PendingEnd p = g.pendingGameEnd;
    g.pendingGameEnd = null;
    endGame(g, Json.MAPPER.readTree(p.json), p.timestamp, ctx);
  }

  /** Feeds a status to a tracker, unless it belongs to another shift. */
  private static void feed(ShiftTracker t, StatusView s) {
    if (t != null && (s.shiftId == null || s.shiftId == t.shiftId)) {
      t.onStatus(s);
    }
  }

  /**
   * The game was restored from the snapshot taken at {@code snapshotTick}: the new epoch replays
   * everything after it, so forget that and reset the marks. A pending end at or before the
   * snapshot is in it and is not replayed, so it is finished now. One after it will be replayed by
   * the new epoch, so it is dropped and its shift reopened (the newer epoch's records win, spec
   * §4.3). A shift that started after the snapshot starts again, so its tracker is dropped.
   */
  private static void rewind(GameState g, int epoch, long snapshotTick, Context ctx, Collector<ShiftReportOut> out)
      throws Exception {
    if (g.pendingShiftEnd != null) {
      if (g.pendingShiftEnd.tick <= snapshotTick) {
        finishShift(g, ctx.getCurrentKey(), out);
      } else {
        g.shift = g.ending;
        g.ending = null;
        g.pendingShiftEnd = null;
      }
    }
    if (g.pendingGameEnd != null) {
      if (g.pendingGameEnd.tick <= snapshotTick) {
        finishGame(g, ctx, out);
        return;
      }
      g.pendingGameEnd = null;
    }
    g.epoch = epoch;
    g.lastSeq = -1;
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
