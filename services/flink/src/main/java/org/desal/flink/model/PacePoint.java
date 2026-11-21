package org.desal.flink.model;

/** Cumulative in-spec water at the end of plant hour {@code hour} (1..8) against the pro-rata target. */
public class PacePoint {
  public int hour;
  public double productM3;
  public double targetM3;

  public PacePoint() {}
}
