package org.desal.flink.model;

/** One shift's headline numbers ({@code ComparisonSchema}), to compare shifts of the same run. */
public class Comparison {
  public int shiftId;
  public double targetPct;
  public int handledWell;
  public int handledOf;
  public double minutesTripped;

  public Comparison() {}
}
