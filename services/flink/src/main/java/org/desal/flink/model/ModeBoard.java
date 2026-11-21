package org.desal.flink.model;

import java.util.List;

/** One mode's board ({@code ModeBoardSchema}): top 10 all time, top 10 today, kind stats. */
public class ModeBoard {
  public List<LeaderboardRow> allTime;
  public List<LeaderboardRow> today;
  public List<KindShare> stats;

  public ModeBoard() {}
}
