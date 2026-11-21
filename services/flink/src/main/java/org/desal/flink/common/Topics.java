package org.desal.flink.common;

/**
 * Kafka topic names, the same as {@code TOPICS} in packages/schema/src/topics.ts. Integration
 * tests pass a unique suffix (like {@code DESAL_TOPIC_SUFFIX} on the TypeScript side) so they use
 * throwaway topics.
 */
public final class Topics {
  public static final String EVENTS = "plant.events";
  public static final String STATUS = "plant.status";
  public static final String SHIFT_REPORTS = "shift.reports";
  public static final String RUN_RESULTS = "run.results";
  public static final String LEADERBOARD = "leaderboard";
  public static final String RUN_RANKS = "run.ranks";

  private Topics() {}

  /** The topic {@code base} with {@code suffix} appended; a null suffix means none. */
  public static String name(String base, String suffix) {
    return suffix == null ? base : base + suffix;
  }
}
