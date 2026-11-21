package org.desal.flink.model;

/**
 * The leaderboard ({@code LeaderboardSchema}) on {@code leaderboard}: one board per mode, since
 * Normal and Hard runs never mix. {@code online} counts plants in both modes.
 */
public class Leaderboard {
  /** Epoch milliseconds. */
  public long updatedAt;
  public int online;
  public ModeBoard normal;
  public ModeBoard hard;

  public Leaderboard() {}
}
