package org.desal.flink.model;

/** How one run handled one event kind ({@code KindStatSchema}). */
public class KindStat {
  public String kind;
  public int count;
  public int handledWell;
  public Double meanResponseMinutes;
  public boolean firstHandledWell;

  public KindStat() {}
}
