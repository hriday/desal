package org.desal.flink.model;

/**
 * Board stat for one graded sharp kind ({@code KindBoardStatSchema}): of the operators who met it,
 * the share who handled their first one well.
 */
public class KindShare {
  public String kind;
  public int operators;
  public double firstHandledWellPct;

  public KindShare() {}
}
