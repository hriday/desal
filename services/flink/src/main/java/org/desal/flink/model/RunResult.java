package org.desal.flink.model;

import java.util.List;

/** One finished run ({@code RunResultSchema}) on {@code run.results}. Carries no gameId. */
public class RunResult {
  public String runId;
  public String callSign;
  /** "normal" or "hard". */
  public String mode = "normal";
  /** Epoch milliseconds. */
  public long endedAt;
  public int shiftsCompleted;
  public double totalProductM3;
  /** A GameEndReason. */
  public String endReason;
  public List<KindStat> kinds;

  public RunResult() {}
}
