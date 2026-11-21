package org.desal.flink.reportcard;

import java.util.Set;

/**
 * The report card's rules: plant time, verdict bands, which kinds are graded and what status shows
 * that the player responded to an event (spec §4.3, Plan 4 §4.3).
 */
public final class Rules {
  /** Verdict bands in plant minutes: quick ≤ 5, ok ≤ 15, slow above. */
  public static final double QUICK_MAX_MIN = 5;
  public static final double OK_MAX_MIN = 15;
  /** One tick is 40 plant seconds. */
  public static final double TICK_MINUTES = 40.0 / 60;
  public static final int TICKS_PER_HOUR = 90;
  public static final int SHIFT_HOURS = 8;

  /**
   * Kinds that get a verdict: the six sharp kinds, controllerFault, bloom, and the two disasters
   * graded on time-to-clear. earthquake is only noted (its children are graded as their own kinds)
   * and the informational kinds need no response.
   */
  private static final Set<String> GRADED = Set.of(
      "pumpTrip", "powerDip", "controllerFault", "sensorFailure", "tubeLeak", "vacuumLoss", "storm",
      "bloom", "fuelContamination", "tsunami");

  private Rules() {}

  /** quick, ok or slow for a response time; missed when there was none (null). */
  public static String verdict(Double responseMinutes) {
    if (responseMinutes == null) {
      return "missed";
    }
    if (responseMinutes <= QUICK_MAX_MIN) {
      return "quick";
    }
    return responseMinutes <= OK_MAX_MIN ? "ok" : "slow";
  }

  public static boolean hasVerdict(String kind) {
    return GRADED.contains(kind);
  }

  /**
   * The crew job that is the response to a kind, or null. flushFuel is never a response:
   * fuelContamination is graded on time-to-clear.
   */
  public static String crewJobFor(String kind) {
    if (kind == null) {
      return null;
    }
    switch (kind) {
      case "tubeLeak": return "plugTubes";
      case "vacuumLoss": return "repairEjector";
      case "storm": return "cleanScreens";
      case "sensorFailure": return "replaceSensor";
      default: return null;
    }
  }

  /**
   * Whether status {@code s} shows the response to {@code e}. The caller checks that the status is
   * later than the firing tick.
   */
  public static boolean responded(OpenEvent e, StatusView s) {
    switch (e.kind) {
      case "pumpTrip":
      case "powerDip":
        return s.pumpsRunning >= 2;
      case "controllerFault":
        // Status reports each loop's fault, so the faulted loop in Manual is the response, whatever its id.
        if (s.loops == null) {
          return false;
        }
        for (StatusView.Loop loop : s.loops.values()) {
          if (loop != null && loop.fault != null && "manual".equals(loop.mode)) {
            return true;
          }
        }
        return false;
      case "bloom":
        return e.baselineChlorine != null && s.chlorineMgL > e.baselineChlorine;
      case "tubeLeak":
      case "vacuumLoss":
      case "storm":
      case "sensorFailure":
        // sensorFailure: only the crew counts; its loop is never given away (Plan 4 R4), so a loop
        // in Manual would credit a guess.
        return crewJobFor(e.kind).equals(s.crewJob);
      default:
        // fuelContamination and tsunami (graded on the clear tick), earthquake, informational kinds.
        return false;
    }
  }

  /** The debrief's wording for how an event was cleared. */
  public static String outcome(String how) {
    if (how == null) {
      return "not cleared";
    }
    switch (how) {
      case "player": return "cleared by you";
      case "crew": return "fixed by crew";
      case "expired": return "passed";
      case "noted": return "noted";
      default: return "not cleared";
    }
  }
}
