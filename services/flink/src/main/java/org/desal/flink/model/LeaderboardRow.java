package org.desal.flink.model;

/** One leaderboard row ({@code LeaderboardRowSchema}); the gateway strips runId before browsers see it. */
public class LeaderboardRow {
  public int rank;
  public String callSign;
  public int shiftsCompleted;
  public double totalProductM3;
  public long endedAt;
  public String runId;

  public LeaderboardRow() {}
}
