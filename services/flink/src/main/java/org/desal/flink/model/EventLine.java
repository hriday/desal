package org.desal.flink.model;

/**
 * One event on the report card ({@code ReportEventSchema}). {@code kind} is a ScenarioKind,
 * {@code outcome} the debrief wording, {@code verdict} quick/ok/slow/missed or null (earthquake).
 */
public class EventLine {
  public int eventId;
  public String kind;
  public double atMinute;
  public Double responseMinutes;
  public Double clearMinutes;
  public String outcome;
  public String verdict;

  public EventLine() {}
}
