package org.desal.flink.reportcard;

/** One fired event of the current shift, as the tracker keeps it in state (a Flink POJO). */
public class OpenEvent {
  /** Unique within the shift; a re-fired event (after a snapshot restore) replaces its record. */
  public int eventId;
  public String kind;
  public long fireTick;
  /** bloom: the chlorine dose when it fired (null when no status had been seen). */
  public Double baselineChlorine;
  /** The first tick at which the response was seen, null until then. */
  public Long responseTick;
  /** The eventCleared tick and its how (player, crew, expired, noted), null while open. */
  public Long clearTick;
  public String how;

  public OpenEvent() {}
}
