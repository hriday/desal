package org.desal.flink.model;

import java.util.List;

/**
 * The shift report card ({@code ShiftReportSchema}), one per finished shift on {@code shift.reports}.
 * The totals (targetM3, productM3, offSpecM3, offSpecMinutes, trips, spentUsd) are copied from the
 * shiftEnd summary, never recomputed.
 */
public class ShiftReport {
  public int shiftId;
  public int epoch;
  /** "normal" or "hard". */
  public String mode = "normal";
  /** A..F. */
  public String grade;
  public double score;
  public double targetM3;
  public double productM3;
  public double offSpecM3;
  public double offSpecMinutes;
  public double trips;
  public double spentUsd;
  public double minutesTripped;
  public Comparison self;
  public List<EventLine> events;
  public List<PacePoint> pace;
  public Comparison vsPrevious;
  public Comparison vsBest;

  public ShiftReport() {}
}
