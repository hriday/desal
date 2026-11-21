package org.desal.flink.model;

/** A run's rank within its own mode ({@code RunRankSchema}); {@code today} is null when not ranked today. */
public class RunRank {
  public String runId;
  public int allTime;
  public Integer today;

  public RunRank() {}
}
