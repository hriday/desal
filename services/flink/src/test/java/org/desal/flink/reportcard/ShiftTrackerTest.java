package org.desal.flink.reportcard;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.ArrayList;
import java.util.List;
import org.desal.flink.common.Json;
import org.desal.flink.model.Comparison;
import org.desal.flink.model.EventLine;
import org.desal.flink.model.PacePoint;
import org.desal.flink.model.ShiftReport;
import org.junit.jupiter.api.Test;

/** Shift 2 of the streaming-notes example: ticks 721..1440, target 4056 m3. */
class ShiftTrackerTest {
  private static final long START = 721;
  private static final double TARGET = 4056;
  private static final double EPS = 1e-9;

  // (a)
  @Test
  void pumpTripRespondedWhenTwoPumpsRun() {
    ShiftTracker t = tracker();
    t.onScenario(1, "pumpTrip", 1000, status(999).pumps(2).view());
    t.onStatus(status(1003).pumps(1).view());
    t.onStatus(status(1006).pumps(2).view());
    EventLine e = only(t);
    assertEquals(4.0, e.responseMinutes, EPS);
    assertEquals("quick", e.verdict);
    assertEquals((1000 - START) * 2.0 / 3, e.atMinute, EPS);
  }

  // (b)
  @Test
  void statusBeforeScenarioIsCredited() {
    ShiftTracker t = tracker();
    StatusView s = status(1006).pumps(2).view();
    t.onStatus(s);
    t.onScenario(1, "pumpTrip", 1000, s);
    EventLine e = only(t);
    assertEquals(4.0, e.responseMinutes, EPS);
    assertEquals("quick", e.verdict);
  }

  @Test
  void aStatusAtTheFireTickIsNotAResponse() {
    ShiftTracker t = tracker();
    t.onScenario(1, "pumpTrip", 1000, status(1000).pumps(2).view());
    t.onStatus(status(1000).pumps(2).view());
    assertNull(only(t).responseMinutes);
  }

  // (c)
  @Test
  void tubeLeakRespondedByTheCrew() {
    ShiftTracker t = tracker();
    t.onScenario(1, "tubeLeak", 1000, status(999).view());
    t.onStatus(status(1010).crew("repairEjector").view());
    t.onStatus(status(1030).crew("plugTubes").view());
    t.onStatus(status(1031).crew("plugTubes").view());
    t.onCleared(1, "crew", 1120);
    EventLine e = only(t);
    assertEquals(20.0, e.responseMinutes, EPS);
    assertEquals("slow", e.verdict);
    assertEquals(80.0, e.clearMinutes, EPS);
    assertEquals("fixed by crew", e.outcome);
  }

  @Test
  void anEarlierStatusResponseReplacesTheClearTickWhenTheClearIsReadFirst() {
    ShiftTracker t = tracker();
    t.onScenario(1, "pumpTrip", 1000, null);
    t.onCleared(1, "player", 1010);
    t.onStatus(status(1003).pumps(1).view());
    t.onStatus(status(1006).pumps(2).view());
    t.onStatus(status(1012).pumps(2).view());
    assertEquals(4.0, only(t).responseMinutes, EPS);
  }

  @Test
  void aCrewDispatchBeforeTheClearCreditsTheEventWhenTheClearIsReadFirst() {
    ShiftTracker t = tracker();
    t.onScenario(1, "tubeLeak", 1000, null);
    t.onCleared(1, "crew", 1120);
    t.onStatus(status(1001).view());
    t.onStatus(status(1030).crew("plugTubes", 90).view());
    EventLine e = only(t);
    assertEquals(20.0, e.responseMinutes, EPS);
    assertEquals(80.0, e.clearMinutes, EPS);
  }

  // (d)
  @Test
  void bloomRespondedWhenTheDoseRisesAboveTheDoseAtFiring() {
    ShiftTracker t = tracker();
    t.onScenario(1, "bloom", 1000, status(999).chlorine(2.0).view());
    t.onStatus(status(1003).chlorine(2.0).view());
    t.onStatus(status(1012).chlorine(2.5).view());
    EventLine e = only(t);
    assertEquals(8.0, e.responseMinutes, EPS);
    assertEquals("ok", e.verdict);
  }

  // (e)
  @Test
  void anExpiredStormWithNoResponsePassed() {
    ShiftTracker t = tracker();
    t.onScenario(1, "storm", 1000, status(999).view());
    t.onCleared(1, "expired", 1060);
    t.onStatus(status(1070).crew("cleanScreens").view());
    EventLine e = only(t);
    assertNull(e.verdict);
    assertNull(e.responseMinutes);
    assertEquals("passed", e.outcome);
    assertEquals(40.0, e.clearMinutes, EPS);
  }

  // (f)
  @Test
  void noResponseByShiftEndIsMissed() {
    ShiftTracker t = tracker();
    t.onScenario(1, "pumpTrip", 1000, status(999).view());
    t.onStatus(status(1003).pumps(1).view());
    ShiftReport r = finish(t);
    EventLine e = r.events.get(0);
    assertEquals("missed", e.verdict);
    assertEquals("not cleared", e.outcome);
    assertNull(e.responseMinutes);
    assertNull(e.clearMinutes);
    assertEquals(0, r.self.handledWell);
    assertEquals(1, r.self.handledOf);
  }

  @Test
  void aPlayerClearWithNoResponseYetCreditsTheClearTick() {
    ShiftTracker t = tracker();
    t.onScenario(1, "controllerFault", 1000, status(999).view());
    t.onCleared(1, "player", 1009);
    EventLine e = only(t);
    assertEquals(6.0, e.responseMinutes, EPS);
    assertEquals("ok", e.verdict);
    assertEquals("cleared by you", e.outcome);
  }

  // (g)
  @Test
  void paceHasEightCumulativePointsEndingOnTheSummary() {
    ShiftTracker t = tracker();
    for (long tick = 730; tick <= 1440; tick += 10) {
      t.onStatus(status(tick).product((tick - START + 1) * 5.0).view());
    }
    List<PacePoint> pace = finish(t).pace;
    assertEquals(8, pace.size());
    for (int h = 1; h <= 7; h++) {
      PacePoint p = pace.get(h - 1);
      assertEquals(h, p.hour);
      assertEquals(450.0 * h, p.productM3, EPS, "hour " + h);
      assertEquals(TARGET * h / 8, p.targetM3, EPS);
    }
    assertEquals(4163.88, pace.get(7).productM3, EPS);
    assertEquals(TARGET, pace.get(7).targetM3, EPS);
  }

  @Test
  void anHourWithNoStatusCarriesTheLastValue() {
    ShiftTracker t = tracker();
    t.onStatus(status(800).product(300).view());
    List<PacePoint> pace = finish(t).pace;
    assertEquals(300, pace.get(0).productM3, EPS);
    assertEquals(300, pace.get(6).productM3, EPS);
  }

  // (h)
  @Test
  void totalsAreCopiedFromTheSummary() {
    ShiftTracker t = tracker();
    t.onStatus(status(800).product(9999).view());
    ShiftReport r = t.finish(summary(4163.88, 4056, 12.5, 4.67, 1, 12349.24), List.of(), "normal");
    assertEquals(2, r.shiftId);
    assertEquals(4163.88, r.productM3, 0);
    assertEquals(4056, r.targetM3, 0);
    assertEquals(12.5, r.offSpecM3, 0);
    assertEquals(4.67, r.offSpecMinutes, 0);
    assertEquals(1, r.trips, 0);
    assertEquals(12349.24, r.spentUsd, 0);
    assertEquals(100 * 4163.88 / 4056, r.self.targetPct, EPS);
    assertEquals(Grading.grade(r.score), r.grade);
  }

  @Test
  void minutesTrippedCountsDistinctRunningTicksTrippedOrRestarting() {
    ShiftTracker t = tracker();
    t.onStatus(status(900).plant("tripped").view());
    t.onStatus(status(900).plant("tripped").view()); // repeat of the same tick
    t.onStatus(status(901).plant("restarting").view());
    t.onStatus(status(901).plant("restarting").phase("paused").view());
    t.onStatus(status(902).plant("restarting").view());
    t.onStatus(status(903).plant("online").view());
    t.onStatus(status(904).plant("tripped").phase("paused").view());
    ShiftReport r = finish(t);
    assertEquals(3 * 2.0 / 3, r.minutesTripped, EPS);
    assertEquals(r.minutesTripped, r.self.minutesTripped, EPS);
  }

  // (i)
  @Test
  void comparisons() {
    ShiftReport first = finish(tracker());
    assertNull(first.vsPrevious);
    assertNull(first.vsBest);

    List<Comparison> history = new ArrayList<>(List.of(comparison(1, 90), comparison(2, 105)));
    ShiftReport third = tracker().finish(summary(4163.88, 4056, 0, 0, 0, 0), history, "normal");
    assertEquals(2, third.vsPrevious.shiftId);
    assertEquals(2, third.vsBest.shiftId);

    history = List.of(comparison(1, 105), comparison(2, 90));
    ShiftReport other = tracker().finish(summary(4163.88, 4056, 0, 0, 0, 0), history, "normal");
    assertEquals(2, other.vsPrevious.shiftId);
    assertEquals(1, other.vsBest.shiftId);
  }

  // (k)
  @Test
  void modeIsCopiedAndDefaultsToNormal() {
    assertEquals("hard", tracker().finish(summary(1, 1, 0, 0, 0, 0), List.of(), "hard").mode);
    ObjectNode json = status(800).json;
    json.remove("mode");
    assertEquals("normal", StatusView.from(json).mode);
    json.put("mode", "hard");
    assertEquals("hard", StatusView.from(json).mode);
  }

  @Test
  void statusViewReadsTheStatusJson() {
    StatusView s = StatusView.from(status(1006).pumps(2).crew("plugTubes").chlorine(2.5).product(1234.5)
        .loop("level12", "manual", "stuck").plant("restarting").view().source);
    assertEquals(1006, s.tick);
    assertEquals(1, s.epoch);
    assertEquals(2, s.shiftId);
    assertEquals("running", s.phase);
    assertEquals("restarting", s.status);
    assertEquals(2, s.pumpsRunning);
    assertEquals("plugTubes", s.crewJob);
    assertEquals(45, s.crewRemainingTicks);
    assertEquals(2.5, s.chlorineMgL, 0);
    assertEquals(1234.5, s.shiftProductM3, 0);
    assertEquals("manual", s.loops.get("level12").mode);
    assertEquals("stuck", s.loops.get("level12").fault);
    assertNull(s.loops.get("tbt").fault);
    assertNull(StatusView.from(status(1).view().source).crewJob);
  }

  // (l)
  @Test
  void fuelContaminationAndTsunamiAreGradedOnTimeToClear() {
    ShiftTracker t = new ShiftTracker();
    t.onShiftStart(1441, 3, TARGET);
    t.onScenario(1, "fuelContamination", 2000, status(1999).view());
    t.onScenario(2, "tsunami", 2000, status(1999).view());
    t.onStatus(status(2003).crew("flushFuel").pumps(1).view());
    t.onStatus(status(2004).pumps(2).view());
    t.onCleared(2, "player", 2006);
    t.onCleared(1, "crew", 2030);
    List<EventLine> events = finish(t).events;
    EventLine fuel = events.get(0);
    assertEquals(20.0, fuel.responseMinutes, EPS);
    assertEquals("slow", fuel.verdict);
    assertEquals("fixed by crew", fuel.outcome);
    EventLine wave = events.get(1);
    assertEquals(4.0, wave.responseMinutes, EPS);
    assertEquals("quick", wave.verdict);
    assertEquals("cleared by you", wave.outcome);
  }

  // (m)
  @Test
  void earthquakeIsNotedAndItsChildIsAnOrdinaryPumpTrip() {
    ShiftTracker t = tracker();
    t.onScenario(1, "earthquake", 1100, status(1099).view());
    t.onCleared(1, "noted", 1100);
    // The cascade child (cascade: true on the scenario) is graded by its own kind.
    t.onScenario(2, "pumpTrip", 1101, status(1100).view());
    t.onStatus(status(1102).pumps(1).view());
    t.onStatus(status(1104).pumps(2).view());
    ShiftReport r = finish(t);
    EventLine quake = r.events.get(0);
    assertFalse(Rules.hasVerdict("earthquake"));
    assertEquals("noted", quake.outcome);
    assertNull(quake.verdict);
    assertNull(quake.responseMinutes);
    EventLine child = r.events.get(1);
    assertEquals(2.0, child.responseMinutes, EPS);
    assertEquals("quick", child.verdict);
    assertEquals(1, r.self.handledOf);
    assertEquals(1, r.self.handledWell);
  }

  // (j) rewindTo takes the snapshot tick R; the new epoch resumes at R + 1 (here 1170), so the
  // brief's "drops hour points ending at or after 1170" is rewindTo(1169).
  @Test
  void rewindDropsHourPointsEndingAfterTheSnapshotTickAndRecomputesThem() {
    ShiftTracker t = tracker();
    for (long tick = 730; tick <= 1260; tick += 10) {
      t.onStatus(status(tick).product((tick - START + 1) * 5.0).view());
    }
    // Hour 5 ends at tick 721 + 450 - 1 = 1170, hour 4 at 1080.
    t.rewindTo(1169);
    assertEquals(List.of(1, 2, 3, 4), t.pace.stream().map(p -> p.hour).toList());
    t.onStatus(status(1170).product(2000).view());
    List<PacePoint> pace = finish(t).pace;
    assertEquals(1800, pace.get(3).productM3, EPS);
    assertEquals(2000, pace.get(4).productM3, EPS);
    // The old epoch's 2700 at tick 1260 is gone: hour 6 carries the new epoch's value.
    assertEquals(2000, pace.get(5).productM3, EPS);
  }

  @Test
  void rewindToTheLastTickOfAnHourKeepsThatHour() {
    ShiftTracker t = tracker();
    for (long tick = 730; tick <= 1260; tick += 10) {
      t.onStatus(status(tick).product((tick - START + 1) * 5.0).view());
    }
    t.rewindTo(1170);
    assertEquals(List.of(1, 2, 3, 4, 5), t.pace.stream().map(p -> p.hour).toList());
  }

  @Test
  void rewindKeepsWhatHappenedAtTheSnapshotTickItself() {
    // Restored while paused: the snapshot is at 1170 and the first new status is stamped 1170.
    ShiftTracker t = tracker();
    t.onScenario(1, "pumpTrip", 1170, status(1169).pumps(1).view());
    t.onScenario(2, "storm", 1160, status(1159).view());
    t.onCleared(2, "expired", 1170);
    t.onStatus(status(1170).pumps(1).plant("tripped").view());
    t.rewindTo(1170);
    t.onStatus(status(1170).pumps(1).plant("tripped").phase("paused").view());
    t.onStatus(status(1171).pumps(2).view());
    ShiftReport r = finish(t);
    assertEquals(2, r.events.size());
    assertEquals(2.0 / 3, r.events.get(0).responseMinutes, EPS);
    assertEquals("passed", r.events.get(1).outcome);
    assertEquals(2.0 / 3, r.minutesTripped, EPS);
  }

  @Test
  void rewindForgetsResponsesClearsAndEventsAfterTheTick() {
    ShiftTracker t = tracker();
    t.onScenario(1, "pumpTrip", 1150, status(1149).view());
    t.onStatus(status(1160).pumps(1).view());
    t.onStatus(status(1175).pumps(2).plant("tripped").view());
    t.onCleared(1, "player", 1176);
    t.onScenario(2, "storm", 1180, status(1179).view());
    t.rewindTo(1170);
    t.onStatus(status(1172).pumps(2).view());
    ShiftReport r = finish(t);
    assertEquals(1, r.events.size());
    EventLine e = r.events.get(0);
    assertEquals(22 * 2.0 / 3, e.responseMinutes, EPS);
    assertEquals("not cleared", e.outcome);
    assertEquals(0, r.minutesTripped, EPS);
  }

  @Test
  void oneReplaceSensorJobCreditsEveryOpenSensorFailure() {
    // An earthquake fires two sensor failures at the same tick. One replaceSensor job repairs every
    // failed sensor and the director clears both as crew when it finishes (a second job is refused).
    ShiftTracker t = tracker();
    t.onScenario(1, "sensorFailure", 1000, status(999).view());
    t.onScenario(2, "sensorFailure", 1000, status(999).view());
    t.onStatus(status(1003).crew("replaceSensor", 45).view());
    t.onStatus(status(1004).crew("replaceSensor", 44).view());
    t.onStatus(status(1047).crew("replaceSensor", 1).view());
    t.onStatus(status(1048).crew(null).view());
    t.onCleared(1, "crew", 1048);
    t.onCleared(2, "crew", 1048);
    for (EventLine e : finish(t).events) {
      assertEquals(2.0, e.responseMinutes, EPS);
      assertEquals("quick", e.verdict);
      assertEquals("fixed by crew", e.outcome);
    }
  }

  @Test
  void aReplaceSensorDispatchSeenBeforeTheScenariosCreditsEachOneFiredBeforeIt() {
    ShiftTracker t = tracker();
    StatusView s = status(1003).crew("replaceSensor", 45).view();
    t.onStatus(s);
    t.onScenario(1, "sensorFailure", 1000, s);
    t.onScenario(2, "sensorFailure", 1000, s);
    // A sensor failure that fires after the job started is not credited by it.
    t.onScenario(3, "sensorFailure", 1010, s);
    List<EventLine> events = finish(t).events;
    assertEquals(2.0, events.get(0).responseMinutes, EPS);
    assertEquals(2.0, events.get(1).responseMinutes, EPS);
    assertNull(events.get(2).responseMinutes);
  }

  @Test
  void eachCrewKindIsCreditedOncePerDispatch() {
    String[][] kinds = {{"tubeLeak", "plugTubes"}, {"vacuumLoss", "repairEjector"}, {"storm", "cleanScreens"}};
    for (String[] k : kinds) {
      ShiftTracker t = tracker();
      t.onScenario(1, k[0], 1000, status(999).view());
      t.onScenario(2, k[0], 1001, status(999).view());
      t.onStatus(status(1006).crew(k[1], 45).view());
      t.onStatus(status(1007).crew(k[1], 44).view());
      List<EventLine> events = finish(t).events;
      assertEquals(4.0, events.get(0).responseMinutes, EPS, k[0]);
      assertNull(events.get(1).responseMinutes, k[0]);
    }
  }

  @Test
  void aDispatchSeenBeforeItsScenarioIsCreditedOnce() {
    ShiftTracker t = tracker();
    StatusView s = status(1030).crew("plugTubes", 90).view();
    t.onStatus(s);
    t.onScenario(1, "tubeLeak", 1000, s);
    t.onScenario(2, "tubeLeak", 1000, s);
    List<EventLine> events = finish(t).events;
    assertEquals(20.0, events.get(0).responseMinutes, EPS);
    assertNull(events.get(1).responseMinutes);

    // The same when the tracker had not been given that status before the scenario.
    ShiftTracker u = tracker();
    StatusView unseen = status(1030).crew("plugTubes", 90).view();
    u.onScenario(1, "tubeLeak", 1000, unseen);
    u.onStatus(unseen);
    u.onScenario(2, "tubeLeak", 1000, unseen);
    events = finish(u).events;
    assertEquals(20.0, events.get(0).responseMinutes, EPS);
    assertNull(events.get(1).responseMinutes);
  }

  @Test
  void aJobStillRunningAcrossARewindIsNotANewDispatch() {
    ShiftTracker t = tracker();
    t.onScenario(1, "tubeLeak", 1150, status(1149).view());
    t.onScenario(2, "tubeLeak", 1155, status(1154).view());
    t.onStatus(status(1160).crew("plugTubes", 90).view());
    t.onStatus(status(1175).crew("plugTubes", 75).view());
    t.rewindTo(1170);
    // The new epoch resumes at 1171 with the same job, 79 ticks left (90 - 11).
    t.onStatus(status(1171).crew("plugTubes", 79).view());
    List<EventLine> events = finish(t).events;
    assertEquals(20.0 / 3, events.get(0).responseMinutes, EPS);
    assertNull(events.get(1).responseMinutes);
  }

  // --- helpers ---

  private static ShiftTracker tracker() {
    ShiftTracker t = new ShiftTracker();
    t.onShiftStart(START, 2, TARGET);
    return t;
  }

  private static EventLine only(ShiftTracker t) {
    List<EventLine> events = finish(t).events;
    assertEquals(1, events.size());
    return events.get(0);
  }

  private static ShiftReport finish(ShiftTracker t) {
    return t.finish(summary(4163.88, TARGET, 0, 0, 0, 12349.24), List.of(), "normal");
  }

  private static Comparison comparison(int shiftId, double targetPct) {
    Comparison c = new Comparison();
    c.shiftId = shiftId;
    c.targetPct = targetPct;
    return c;
  }

  /** A shiftEnd summary shaped like the streaming-notes example. */
  private static JsonNode summary(double product, double target, double offSpecM3, double offSpecMinutes,
      double trips, double spent) {
    ObjectNode s = Json.MAPPER.createObjectNode();
    s.put("productM3", product).put("targetM3", target).put("offSpecMinutes", offSpecMinutes)
        .put("offSpecM3", offSpecM3).put("fuelCostUsd", 9829.24).put("fuelBudgetUsd", 12480)
        .put("trips", trips).put("spentUsd", spent).put("nextAllocationUsd", 10340)
        .put("balanceUsd", 13373.09).put("hell", false);
    s.putObject("damage").put("maxHardScaleMm", 0).put("burnerCondition", 1).putObject("pumpWear");
    s.putArray("events");
    return s;
  }

  private static StatusJson status(long tick) {
    return new StatusJson(tick);
  }

  /** A plant.status record (status.ts) with the fields the report card reads, editable per test. */
  static final class StatusJson {
    final ObjectNode json = Json.MAPPER.createObjectNode();

    StatusJson(long tick) {
      json.put("gameId", "8f14e45f-ceea-467a-9575-1f2b0c6e4a11").put("callSign", "Kestrel-42")
          .put("epoch", 1).put("shiftNumber", 2).put("tick", tick).put("plantTime", tick * 40_000)
          .put("shiftId", 2).put("phase", "running").put("status", "online").put("controlMode", "auto")
          .put("shiftProductM3", 0).put("shiftOffSpecM3", 0).put("mode", "normal");
      json.putNull("crew");
      ObjectNode loops = json.putObject("loops");
      loops.putObject("tbt").put("mode", "auto").put("setpoint", 93.5).put("output", 50).putNull("fault");
      loops.putObject("makeup").put("mode", "auto").put("setpoint", 1).put("output", 50);
      json.putObject("doses").put("chlorineMgL", 2.0).put("antiscalantMgL", 3.0);
      pumps(2);
    }

    StatusJson pumps(int running) {
      ObjectNode pumps = json.putObject("pumps");
      String[] ids = {"P-101", "P-102", "P-103"};
      for (int i = 0; i < ids.length; i++) {
        pumps.putObject(ids[i]).put("running", i < running).put("overhaulRemainingTicks", 0);
      }
      return this;
    }

    StatusJson crew(String job) {
      return crew(job, 45);
    }

    StatusJson crew(String job, long remainingTicks) {
      if (job == null) {
        json.putNull("crew");
      } else {
        json.putObject("crew").put("job", job).put("remainingTicks", remainingTicks);
      }
      return this;
    }

    StatusJson chlorine(double mgL) {
      ((ObjectNode) json.get("doses")).put("chlorineMgL", mgL);
      return this;
    }

    StatusJson product(double m3) {
      json.put("shiftProductM3", m3);
      return this;
    }

    StatusJson plant(String status) {
      json.put("status", status);
      return this;
    }

    StatusJson phase(String phase) {
      json.put("phase", phase);
      return this;
    }

    StatusJson loop(String id, String mode, String fault) {
      ((ObjectNode) json.get("loops")).putObject(id).put("mode", mode).put("setpoint", 1).put("output", 1)
          .put("fault", fault);
      return this;
    }

    Parsed view() {
      return new Parsed(json.deepCopy());
    }
  }

  /** Lets tests pass the parsed view to the tracker and still reach the JSON it came from. */
  static final class Parsed extends StatusView {
    final ObjectNode source;

    Parsed(ObjectNode source) {
      this.source = source;
      StatusView v = StatusView.from(source);
      tick = v.tick;
      epoch = v.epoch;
      shiftId = v.shiftId;
      mode = v.mode;
      phase = v.phase;
      status = v.status;
      pumpsRunning = v.pumpsRunning;
      loops = v.loops;
      chlorineMgL = v.chlorineMgL;
      crewJob = v.crewJob;
      crewRemainingTicks = v.crewRemainingTicks;
      shiftProductM3 = v.shiftProductM3;
    }
  }
}
