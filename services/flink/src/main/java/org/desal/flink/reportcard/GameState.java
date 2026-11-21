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
  /** The last event seq applied in this epoch (-1: none). */
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
   * A shiftEnd held until status has caught up with it, and the tracker of the shift it ends
   * (still fed the statuses up to the end tick); null when none is pending.
   */
  public PendingEnd pendingShiftEnd;
  public ShiftTracker ending;
  /** A gameEnd held until status has caught up with it; null when none is pending. */
  public PendingEnd pendingGameEnd;

  public GameState() {}

  /** An end record (shiftEnd or gameEnd) waiting for status to reach its tick. */
  public static class PendingEnd {
    /** The record's JSON. */
    public String json;
    public int epoch;
    public long tick;
    /** The record's Kafka timestamp (gameEnd's endedAt). */
    public long timestamp;
    /** Processing time (ms) after which it is finished with what the job has. */
    public long deadline;

    public PendingEnd() {}
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
