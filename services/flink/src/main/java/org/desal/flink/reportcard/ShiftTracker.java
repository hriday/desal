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
 *
 * <p>Crew kinds (tubeLeak, vacuumLoss, storm, sensorFailure) are credited by a crew dispatch, not
 * by every status showing the job. A plugTubes, repairEjector or cleanScreens job fixes one fault,
 * so it credits only the oldest open, not yet credited event of its kind. A replaceSensor job
 * repairs every failed sensor at once (the simulator then clears each sensorFailure), so it credits
 * every open sensorFailure fired before it, e.g. the two an earthquake fires together. A dispatch
 * is a status whose crew job differs from the previous status's, or whose remaining ticks went up
 * (a new job).
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
  /** Crew dispatches seen this shift, in order. */
  public List<CrewDispatch> dispatches = new ArrayList<>();
  /** The crew's job and remaining ticks at the last running status (null, 0 when idle). */
  public String crewJob;
  public long crewRemainingTicks;

  /** One crew job as first seen in status, and the event it credited (null: none yet). */
  public static class CrewDispatch {
    public String job;
    public long tick;
    /** The job's remaining ticks at {@code tick}. */
    public long remainingTicks;
    /** The event it credited (for replaceSensor, the last of those it credited); null: none yet. */
    public Integer eventId;

    public CrewDispatch() {}
  }

  public ShiftTracker() {}

  public void onShiftStart(long tick, int shiftId, double targetM3) {
    this.shiftId = shiftId;
    this.startTick = tick;
    this.targetM3 = targetM3;
    this.events = new ArrayList<>();
    this.pace = new ArrayList<>();
    this.trippedTicks = new ArrayList<>();
    this.lastStatusTick = tick - 1;
    this.dispatches = new ArrayList<>();
    this.crewJob = null;
    this.crewRemainingTicks = 0;
  }

  /**
   * An event fired at {@code tick}. {@code latest} is the newest status seen (or null); it is the
   * bloom baseline, and if it is already later than the firing and shows the response (status read
   * before the event, as topics are consumed independently) it is credited. For a crew kind, that
   * means a dispatch after the firing that has not credited another event.
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
    String job = Rules.crewJobFor(kind);
    if (job == null) {
      if (latest != null) {
        credit(e, latest);
      }
      return;
    }
    if (latest != null && latest.tick > lastStatusTick && latest.tick >= startTick && "running".equals(latest.phase)) {
      detectDispatch(latest); // a status the tracker has not seen yet; it may credit e itself
    }
    if (e.responseTick == null) {
      for (CrewDispatch d : dispatches) {
        if ((d.eventId == null || fixesAll(job)) && d.job.equals(job) && d.tick > e.fireTick) {
          e.responseTick = d.tick;
          d.eventId = e.eventId;
          break;
        }
      }
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
      if (e.clearTick == null && Rules.crewJobFor(e.kind) == null) {
        credit(e, s);
      }
    }
    detectDispatch(s);
    recordPace(s);
    if (s.tick > lastStatusTick) {
      if ("tripped".equals(s.status) || "restarting".equals(s.status)) {
        trippedTicks.add(s.tick);
      }
      lastStatusTick = s.tick;
    }
  }

  /**
   * The game was restored from the snapshot taken at {@code tick}: the snapshot holds everything up
   * to and including that tick, and the new epoch replays what came after. So everything this
   * tracker learned strictly after it is forgotten: hour points ending after it (recomputed from the
   * new statuses), events fired after it (they fire again), and responses, clears, trip ticks and
   * crew dispatches after it. A game restored while paused re-sends status at {@code tick} itself,
   * and an event fired at {@code tick} is in the snapshot and never re-fired, so it is kept.
   */
  public void rewindTo(long tick) {
    pace.removeIf(p -> hourEndTick(p.hour) > tick);
    events.removeIf(e -> e.fireTick > tick);
    for (OpenEvent e : events) {
      if (e.responseTick != null && e.responseTick > tick) {
        e.responseTick = null;
      }
      if (e.clearTick != null && e.clearTick > tick) {
        e.clearTick = null;
        e.how = null;
      }
    }
    trippedTicks.removeIf(t -> t > tick);
    lastStatusTick = Math.min(lastStatusTick, tick);
    dispatches.removeIf(d -> d.tick > tick);
    // The crew as it was at the snapshot: the last surviving job, counted down one per running tick.
    crewJob = null;
    crewRemainingTicks = 0;
    if (!dispatches.isEmpty()) {
      CrewDispatch last = dispatches.get(dispatches.size() - 1);
      long left = last.remainingTicks - (tick - last.tick);
      if (left > 0) {
        crewJob = last.job;
        crewRemainingTicks = left;
      }
    }
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

    r.events = lines();
    List<String> verdicts = new ArrayList<>();
    int handledWell = 0;
    for (EventLine line : r.events) {
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

  /**
   * The shift's events as report-card lines, in eventId order, graded as of now (an event with no
   * response yet is missed). Used by {@link #finish} and, for a shift still open at gameEnd, by the
   * run's per-kind stats.
   */
  public List<EventLine> lines() {
    List<OpenEvent> ordered = new ArrayList<>(events);
    ordered.sort(Comparator.comparingInt(e -> e.eventId));
    List<EventLine> out = new ArrayList<>();
    for (OpenEvent e : ordered) {
      out.add(line(e));
    }
    return out;
  }

  /** replaceSensor repairs every failed sensor; the other jobs fix one fault each. */
  private static boolean fixesAll(String job) {
    return "replaceSensor".equals(job);
  }

  /**
   * Records a new crew job seen in {@code s} and credits the event it fixes: the oldest open one,
   * or every open one for replaceSensor.
   */
  private void detectDispatch(StatusView s) {
    String job = s.crewJob;
    boolean dispatched = job != null && (!job.equals(crewJob) || s.crewRemainingTicks > crewRemainingTicks);
    crewJob = job;
    crewRemainingTicks = job == null ? 0 : s.crewRemainingTicks;
    if (!dispatched) {
      return;
    }
    CrewDispatch d = new CrewDispatch();
    d.job = job;
    d.tick = s.tick;
    d.remainingTicks = s.crewRemainingTicks;
    dispatches.add(d);
    OpenEvent oldest = null;
    for (OpenEvent e : events) {
      boolean fixes = e.clearTick == null && e.responseTick == null && job.equals(Rules.crewJobFor(e.kind))
          && e.fireTick < s.tick;
      if (fixes && fixesAll(job)) {
        e.responseTick = s.tick;
        d.eventId = e.eventId;
      } else if (fixes && (oldest == null || e.fireTick < oldest.fireTick
              || (e.fireTick == oldest.fireTick && e.eventId < oldest.eventId))) {
        oldest = e;
      }
    }
    if (oldest != null) {
      oldest.responseTick = s.tick;
      d.eventId = oldest.eventId;
    }
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
