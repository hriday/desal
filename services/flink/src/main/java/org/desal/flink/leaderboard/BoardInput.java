package org.desal.flink.leaderboard;

import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;

/**
 * One change from one of the three SQL results, as a Flink POJO so the three changelog streams
 * can be unioned into the one assembler. {@code source} says which result it came from and which
 * fields are set; {@code retract} is true for a row the result takes back (a changelog's
 * UPDATE_BEFORE or DELETE) and false for a row it adds (INSERT or UPDATE_AFTER).
 */
public class BoardInput {
  public enum Source { RANKED, STATS, ONLINE }

  public Source source;
  public boolean retract;

  // RANKED: one run and its all-time rank within its mode. STATS also sets mode.
  public String runId;
  public String callSign;
  public String mode;
  public int shiftsCompleted;
  public double totalProductM3;
  public long endedAt;
  public int rank;

  // STATS: one (mode, kind) count.
  public String kind;
  public int operators;
  public int firstWell;

  // ONLINE: plants with a status in one 60 s window.
  public int online;

  public BoardInput() {}

  public static BoardInput ranked(boolean retract, String runId, String callSign, String mode, int shiftsCompleted,
      double totalProductM3, long endedAt, int rank) {
    BoardInput in = new BoardInput();
    in.source = Source.RANKED;
    in.retract = retract;
    in.runId = runId;
    in.callSign = callSign;
    in.mode = mode;
    in.shiftsCompleted = shiftsCompleted;
    in.totalProductM3 = totalProductM3;
    in.endedAt = endedAt;
    in.rank = rank;
    return in;
  }

  public static BoardInput stat(boolean retract, String mode, String kind, int operators, int firstWell) {
    BoardInput in = new BoardInput();
    in.source = Source.STATS;
    in.retract = retract;
    in.mode = mode;
    in.kind = kind;
    in.operators = operators;
    in.firstWell = firstWell;
    return in;
  }

  public static BoardInput online(int online) {
    BoardInput in = new BoardInput();
    in.source = Source.ONLINE;
    in.online = online;
    return in;
  }

  /** A row of {@link LeaderboardSql.Queries#ranked}. */
  public static BoardInput fromRanked(Row r) {
    return ranked(isRetraction(r), r.getFieldAs("runId"), r.getFieldAs("callSign"), r.getFieldAs("mode"),
        num(r, "shiftsCompleted").intValue(), num(r, "totalProductM3").doubleValue(),
        num(r, "endedAt").longValue(), num(r, "rn").intValue());
  }

  /** A row of {@link LeaderboardSql.Queries#stats}. */
  public static BoardInput fromStats(Row r) {
    return stat(isRetraction(r), r.getFieldAs("mode"), r.getFieldAs("kind"),
        num(r, "operators").intValue(), num(r, "firstWell").intValue());
  }

  /** A row of {@link LeaderboardSql.Queries#online}; window results are only ever added. */
  public static BoardInput fromOnline(Row r) {
    return online(num(r, "online").intValue());
  }

  /**
   * A numeric column, 0 when null. run.results is read from the start on every fresh start, so a
   * record with a missing number must not fail the job (it would fail again on every restart).
   */
  private static Number num(Row r, String name) {
    Number n = r.getFieldAs(name);
    return n == null ? 0 : n;
  }

  private static boolean isRetraction(Row r) {
    return r.getKind() == RowKind.UPDATE_BEFORE || r.getKind() == RowKind.DELETE;
  }
}
