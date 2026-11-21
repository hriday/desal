package org.desal.flink.reportcard;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.desal.flink.model.Comparison;
import org.desal.flink.model.KindStat;

/**
 * Everything the report-card job keeps for one game (keyed by gameId). It is a Flink POJO: public
 * class, public no-arg constructor, public non-final fields, and every field (List and Map
 * elements included) is itself a POJO or a basic type. Flink then serializes it field by field
 * with its PojoSerializer and never with Kryo, so a savepoint can still be restored after a field
 * is added or removed (POJO schema evolution); GameStateTest checks this.
 */
public class GameState {
  /** Snapshot restores so far; a higher epoch on a record means the game rewound. */
  public int epoch;
  /** The last event seq accepted in {@link #bufferedEpoch} (-1: none). */
  public long lastSeq = -1;
  /** The last status tick applied in this epoch (-1: none). */
  public long lastStatusTick = -1;
  /** Set on gameEnd; later records are ignored. */
  public boolean ended;
  public String callSign;
  /** From shiftEnd (and gameEnd); never sent to a browser. */
  public String runId;
  /** From gameStart, "normal" when absent. */
  public String mode = "normal";
  /** The running shift, null between shifts. */
  public ShiftTracker shift;
  /** One entry per completed shift, in order. */
  public List<Comparison> history = new ArrayList<>();
  /** Per-kind run stats, keyed by kind. */
  public Map<String, KindTally> kinds = new HashMap<>();
  /** The newest status seen (credits a response seen before its scenario event). */
  public StatusView lastStatus;

  /**
   * Events accepted but not yet applied, in (epoch, tick, seq) order. An event is applied only
   * once status has reached its tick (see ReportCardFunction), so the two inputs stay aligned.
   */
  public List<BufferedEvent> buffer = new ArrayList<>();
  /** The epoch of the newest event accepted into the buffer; {@link #lastSeq} belongs to it. */
  public int bufferedEpoch;
  /**
   * Processing time (ms) of the last progress: the buffer filling up from empty, or a status being
   * applied. The buffer is flushed when there has been none for PENDING_END_TIMEOUT_MS.
   */
  public long lastProgressAt;

  public GameState() {}

  /** One plant.events record waiting for status to catch up. */
  public static class BufferedEvent {
    /** The record's JSON. */
    public String json;
    public String type;
    public int epoch;
    public long tick;
    public long seq;
    /** The record's Kafka timestamp (gameEnd's endedAt). */
    public long timestamp;

    public BufferedEvent() {}
  }

  /**
   * Running totals for one kind over the run. {@link KindStat} carries the mean, which cannot be
   * updated without the sum and count behind it, so state keeps those and the result is built with
   * {@link #toKindStat()}.
   */
  public static class KindTally {
    public String kind;
    public int count;
    public int handledWell;
    public double responseMinutesSum;
    public int responses;
    /** Whether the first event of this kind in the run was handled well. */
    public boolean firstHandledWell;

    public KindTally() {}

    public KindStat toKindStat() {
      KindStat s = new KindStat();
      s.kind = kind;
      s.count = count;
      s.handledWell = handledWell;
      s.meanResponseMinutes = responses == 0 ? null : responseMinutesSum / responses;
      s.firstHandledWell = firstHandledWell;
      return s;
    }
  }
}
