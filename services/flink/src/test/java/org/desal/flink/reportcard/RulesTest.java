package org.desal.flink.reportcard;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.LinkedHashMap;
import org.junit.jupiter.api.Test;

class RulesTest {

  @Test
  void verdictBands() {
    assertEquals("quick", Rules.verdict(5.0));
    assertEquals("ok", Rules.verdict(5.01));
    assertEquals("ok", Rules.verdict(15.0));
    assertEquals("slow", Rules.verdict(15.1));
    assertEquals("missed", Rules.verdict(null));
  }

  @Test
  void whichKindsGetAVerdict() {
    for (String k : new String[] {"pumpTrip", "powerDip", "controllerFault", "sensorFailure", "tubeLeak",
        "vacuumLoss", "storm", "bloom", "fuelContamination", "tsunami", "lowSteam"}) {
      assertTrue(Rules.hasVerdict(k), k);
    }
    for (String k : new String[] {"earthquake", "seawaterTemp", "pumpBearing", "gasCurtailNotice",
        "gasPriceSpike", "offgradeOnly", "deliveryDelay", "demandChange"}) {
      assertFalse(Rules.hasVerdict(k), k);
    }
  }

  @Test
  void lowSteamNeedsTheStandbyLine() {
    OpenEvent e = event("lowSteam");
    assertFalse(Rules.responded(e, status(s -> s.standbySteam = false)));
    assertFalse(Rules.responded(e, status(s -> {
      s.standbySteam = false;
      s.crewJob = "repairEjector";
    })));
    assertTrue(Rules.responded(e, status(s -> s.standbySteam = true)));
    assertNull(Rules.crewJobFor("lowSteam"));
  }

  @Test
  void crewJobs() {
    assertEquals("plugTubes", Rules.crewJobFor("tubeLeak"));
    assertEquals("repairEjector", Rules.crewJobFor("vacuumLoss"));
    assertEquals("cleanScreens", Rules.crewJobFor("storm"));
    assertEquals("replaceSensor", Rules.crewJobFor("sensorFailure"));
    assertNull(Rules.crewJobFor("fuelContamination"));
    assertNull(Rules.crewJobFor("tsunami"));
    assertNull(Rules.crewJobFor("pumpTrip"));
  }

  @Test
  void outcomes() {
    assertEquals("cleared by you", Rules.outcome("player"));
    assertEquals("fixed by crew", Rules.outcome("crew"));
    assertEquals("passed", Rules.outcome("expired"));
    assertEquals("noted", Rules.outcome("noted"));
    assertEquals("not cleared", Rules.outcome(null));
  }

  @Test
  void pumpTripAndPowerDipNeedTwoPumps() {
    for (String kind : new String[] {"pumpTrip", "powerDip"}) {
      OpenEvent e = event(kind);
      assertFalse(Rules.responded(e, status(s -> s.pumpsRunning = 1)), kind);
      assertTrue(Rules.responded(e, status(s -> s.pumpsRunning = 2)), kind);
      assertTrue(Rules.responded(e, status(s -> s.pumpsRunning = 3)), kind);
    }
  }

  @Test
  void controllerFaultNeedsTheFaultedLoopInManual() {
    OpenEvent e = event("controllerFault");
    assertFalse(Rules.responded(e, status(s -> {
      s.loops.put("level7", loop("auto", "stuck"));
      s.loops.put("tbt", loop("manual", null));
    })));
    // Plan 7 loop ids: any loop id works, including makeup and level1..level23.
    assertTrue(Rules.responded(e, status(s -> s.loops.put("level23", loop("manual", "drift")))));
    assertTrue(Rules.responded(e, status(s -> s.loops.put("makeup", loop("manual", "oscillate")))));
  }

  @Test
  void bloomNeedsTheDoseAboveTheBaseline() {
    OpenEvent e = event("bloom");
    e.baselineChlorine = 2.0;
    assertFalse(Rules.responded(e, status(s -> s.chlorineMgL = 2.0)));
    assertTrue(Rules.responded(e, status(s -> s.chlorineMgL = 2.5)));
    e.baselineChlorine = null;
    assertFalse(Rules.responded(e, status(s -> s.chlorineMgL = 9.0)));
  }

  @Test
  void crewKindsNeedTheirOwnCrewJob() {
    assertTrue(Rules.responded(event("tubeLeak"), status(s -> s.crewJob = "plugTubes")));
    assertFalse(Rules.responded(event("tubeLeak"), status(s -> s.crewJob = "repairEjector")));
    assertTrue(Rules.responded(event("vacuumLoss"), status(s -> s.crewJob = "repairEjector")));
    assertTrue(Rules.responded(event("storm"), status(s -> s.crewJob = "cleanScreens")));
    assertTrue(Rules.responded(event("sensorFailure"), status(s -> s.crewJob = "replaceSensor")));
    assertFalse(Rules.responded(event("storm"), status(s -> s.crewJob = null)));
  }

  @Test
  void sensorFailureIsNotCreditedByAManualLoop() {
    // R4: the faulted sensor's loop is never given away, so a loop in Manual is a guess.
    assertFalse(Rules.responded(event("sensorFailure"), status(s -> {
      s.loops.put("level3", loop("manual", null));
      s.loops.put("tbt", loop("manual", null));
    })));
  }

  @Test
  void modeKindsAreNeverCreditedByStatus() {
    StatusView anything = status(s -> {
      s.pumpsRunning = 3;
      s.crewJob = "flushFuel";
      s.chlorineMgL = 99;
      s.loops.put("tbt", loop("manual", "stuck"));
    });
    assertFalse(Rules.responded(event("fuelContamination"), anything));
    assertFalse(Rules.responded(event("tsunami"), anything));
    assertFalse(Rules.responded(event("earthquake"), anything));
    assertFalse(Rules.responded(event("seawaterTemp"), anything));
  }

  static OpenEvent event(String kind) {
    OpenEvent e = new OpenEvent();
    e.eventId = 1;
    e.kind = kind;
    e.fireTick = 1000;
    return e;
  }

  static StatusView.Loop loop(String mode, String fault) {
    StatusView.Loop l = new StatusView.Loop();
    l.mode = mode;
    l.fault = fault;
    return l;
  }

  static StatusView status(java.util.function.Consumer<StatusView> edit) {
    StatusView s = new StatusView();
    s.tick = 1001;
    s.phase = "running";
    s.status = "online";
    s.pumpsRunning = 2;
    s.loops = new LinkedHashMap<>();
    edit.accept(s);
    return s;
  }
}
