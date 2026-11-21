package org.desal.flink.reportcard;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import org.desal.flink.model.Comparison;
import org.desal.flink.model.EventLine;
import org.desal.flink.model.PacePoint;
import org.desal.flink.model.ShiftReport;

/**
 * Follows one shift: its fired events and the responses status shows, the hourly pace and the
 * minutes tripped, and on shiftEnd turns them into a {@link ShiftReport}. A Flink POJO (public
 * fields, no-arg constructor), because it is part of the job's keyed state.
 *
 * <p>Response rule: a status counts only if its tick is later than the firing tick. An
 * eventCleared with how player or crew and no response yet credits the clear tick (this is how
 * fuelContamination and tsunami are graded).
 */
public class ShiftTracker {
  public int shiftId;
  /** The shift's first tick (plant minute 0). */
  public long startTick;
  public double targetM3;
  /** In firing order; at most 7 per shift. */
  public List<OpenEvent> events = new ArrayList<>();
  /** Hours (1..8) seen so far, each holding the cumulative product of its last status. */
  public List<PacePoint> pace = new ArrayList<>();
  /** Distinct running ticks at which the plant was tripped or restarting. */
  public List<Long> trippedTicks = new ArrayList<>();
  /** The latest status tick seen; a repeated tick (handover, pause) is not counted again. */
  public long lastStatusTick = -1;

  public ShiftTracker() {}

  public void onShiftStart(long tick, int shiftId, double targetM3) {
    this.shiftId = shiftId;
    this.startTick = tick;
    this.targetM3 = targetM3;
    this.events = new ArrayList<>();
    this.pace = new ArrayList<>();
    this.trippedTicks = new ArrayList<>();
    this.lastStatusTick = tick - 1;
  }

  /**
   * An event fired at {@code tick}. {@code latest} is the newest status seen (or null); it is the
   * bloom baseline, and if it is already later than the firing and shows the response (status read
   * before the event, as topics are consumed independently) it is credited.
   */
  public void onScenario(int eventId, String kind, long tick, StatusView latest) {
    events.removeIf(e -> e.eventId == eventId);
    OpenEvent e = new OpenEvent();
    e.eventId = eventId;
    e.kind = kind;
    e.fireTick = tick;
    if (latest != null) {
      e.baselineChlorine = latest.chlorineMgL;
    }
    events.add(e);
    if (latest != null) {
      credit(e, latest);
    }
  }

  public void onCleared(int eventId, String how, long tick) {
    for (OpenEvent e : events) {
      if (e.eventId == eventId) {
        e.clearTick = tick;
        e.how = how;
        if (e.responseTick == null && Rules.hasVerdict(e.kind)
            && ("player".equals(how) || "crew".equals(how))) {
          e.responseTick = tick;
        }
      }
    }
  }

  public void onStatus(StatusView s) {
    if (!"running".equals(s.phase) || s.tick < startTick) {
      return;
    }
    for (OpenEvent e : events) {
      if (e.baselineChlorine == null && s.tick <= e.fireTick) {
        e.baselineChlorine = s.chlorineMgL;
      }
      if (e.clearTick == null) {
        credit(e, s);
      }
    }
    recordPace(s);
    if (s.tick > lastStatusTick) {
      if ("tripped".equals(s.status) || "restarting".equals(s.status)) {
        trippedTicks.add(s.tick);
      }
      lastStatusTick = s.tick;
    }
  }

  /**
   * The game was restored from a snapshot and resumes at {@code tick}: everything this tracker
   * learned at or after it is replayed by the new epoch, so forget it. Hour points ending at or
   * after the tick are dropped and recomputed from the new statuses; events fired at or after it
   * are dropped (they fire again), and responses, clears and trip ticks at or after it are undone.
   */
  public void rewindTo(long tick) {
    pace.removeIf(p -> hourEndTick(p.hour) >= tick);
    events.removeIf(e -> e.fireTick >= tick);
    for (OpenEvent e : events) {
      if (e.responseTick != null && e.responseTick >= tick) {
        e.responseTick = null;
      }
      if (e.clearTick != null && e.clearTick >= tick) {
        e.clearTick = null;
        e.how = null;
      }
    }
    trippedTicks.removeIf(t -> t >= tick);
    lastStatusTick = Math.min(lastStatusTick, tick - 1);
  }

  /**
   * The report card for the shiftEnd {@code summary} (its {@code summary} object). Totals are
   * copied from it, never recomputed. {@code history} is the run's earlier shifts in order. The
   * caller sets {@code epoch} on the result.
   */
  public ShiftReport finish(JsonNode summary, List<Comparison> history, String mode) {
    ShiftReport r = new ShiftReport();
    r.shiftId = shiftId;
    r.mode = mode == null ? "normal" : mode;
    r.targetM3 = summary.path("targetM3").asDouble();
    r.productM3 = summary.path("productM3").asDouble();
    r.offSpecM3 = summary.path("offSpecM3").asDouble();
    r.offSpecMinutes = summary.path("offSpecMinutes").asDouble();
    r.trips = summary.path("trips").asDouble();
    r.spentUsd = summary.path("spentUsd").asDouble();
    r.minutesTripped = trippedTicks.size() * Rules.TICK_MINUTES;

    r.events = new ArrayList<>();
    List<String> verdicts = new ArrayList<>();
    int handledWell = 0;
    List<OpenEvent> ordered = new ArrayList<>(events);
    ordered.sort(Comparator.comparingInt(e -> e.eventId));
    for (OpenEvent e : ordered) {
      EventLine line = line(e);
      r.events.add(line);
      if (line.verdict != null) {
        verdicts.add(line.verdict);
        if (line.verdict.equals("quick") || line.verdict.equals("ok")) {
          handledWell++;
        }
      }
    }

    r.pace = finishPace(r.productM3, r.targetM3);

    Comparison self = new Comparison();
    self.shiftId = shiftId;
    self.targetPct = r.targetM3 > 0 ? 100 * r.productM3 / r.targetM3 : 0;
    self.handledWell = handledWell;
    self.handledOf = verdicts.size();
    self.minutesTripped = r.minutesTripped;
    r.self = self;

    r.score = Grading.score(r.productM3, r.targetM3, verdicts, (int) Math.round(r.trips), r.offSpecMinutes);
    r.grade = Grading.grade(r.score);

    r.vsPrevious = history.isEmpty() ? null : history.get(history.size() - 1);
    r.vsBest = history.stream().max(Comparator.comparingDouble(c -> c.targetPct)).orElse(null);
    return r;
  }

  private void credit(OpenEvent e, StatusView s) {
    if (e.responseTick == null && s.tick > e.fireTick && "running".equals(s.phase)
        && Rules.hasVerdict(e.kind) && Rules.responded(e, s)) {
      e.responseTick = s.tick;
    }
  }

  private EventLine line(OpenEvent e) {
    EventLine line = new EventLine();
    line.eventId = e.eventId;
    line.kind = e.kind;
    line.atMinute = (e.fireTick - startTick) * Rules.TICK_MINUTES;
    line.responseMinutes = e.responseTick == null ? null : (e.responseTick - e.fireTick) * Rules.TICK_MINUTES;
    line.clearMinutes = e.clearTick == null ? null : (e.clearTick - e.fireTick) * Rules.TICK_MINUTES;
    line.outcome = Rules.outcome(e.how);
    if (!Rules.hasVerdict(e.kind) || (e.responseTick == null && "expired".equals(e.how))) {
      line.verdict = null; // no verdict for noted kinds; an event that passed by itself is not missed
    } else {
      line.verdict = Rules.verdict(line.responseMinutes);
    }
    return line;
  }

  /** Point h holds the product of the last status within the shift's first h hours. */
  private void recordPace(StatusView s) {
    long offset = s.tick - startTick + 1;
    int hour = (int) Math.min(Rules.SHIFT_HOURS, Math.max(1, (offset + Rules.TICKS_PER_HOUR - 1) / Rules.TICKS_PER_HOUR));
    for (PacePoint p : pace) {
      if (p.hour == hour) {
        p.productM3 = s.shiftProductM3;
        return;
      }
    }
    PacePoint p = new PacePoint();
    p.hour = hour;
    p.productM3 = s.shiftProductM3;
    pace.add(p);
  }

  /** Eight points; an hour with no status carries the hour before it; hour 8 is the summary's product. */
  private List<PacePoint> finishPace(double productM3, double targetM3) {
    double[] seen = new double[Rules.SHIFT_HOURS + 1];
    boolean[] has = new boolean[Rules.SHIFT_HOURS + 1];
    for (PacePoint p : pace) {
      seen[p.hour] = p.productM3;
      has[p.hour] = true;
    }
    List<PacePoint> out = new ArrayList<>();
    double carried = 0;
    for (int h = 1; h <= Rules.SHIFT_HOURS; h++) {
      carried = has[h] ? seen[h] : carried;
      PacePoint p = new PacePoint();
      p.hour = h;
      p.productM3 = h == Rules.SHIFT_HOURS ? productM3 : carried;
      p.targetM3 = targetM3 * h / Rules.SHIFT_HOURS;
      out.add(p);
    }
    return out;
  }

  private long hourEndTick(int hour) {
    return startTick + (long) Rules.TICKS_PER_HOUR * hour - 1;
  }
}
