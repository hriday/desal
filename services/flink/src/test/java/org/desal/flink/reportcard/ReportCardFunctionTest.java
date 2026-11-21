package org.desal.flink.reportcard;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.ConcurrentLinkedQueue;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.java.typeutils.PojoTypeInfo;
import org.apache.flink.streaming.runtime.streamrecord.StreamRecord;
import org.apache.flink.streaming.util.KeyedTwoInputStreamOperatorTestHarness;
import org.apache.flink.streaming.util.ProcessFunctionTestHarnesses;
import org.apache.flink.types.PojoTestUtils;
import org.apache.flink.util.Collector;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.common.header.internals.RecordHeaders;
import org.apache.kafka.common.record.TimestampType;
import org.desal.flink.common.Json;
import org.desal.flink.model.EventLine;
import org.desal.flink.model.KindStat;
import org.desal.flink.model.PacePoint;
import org.desal.flink.model.RunResult;
import org.desal.flink.model.ShiftReport;
import org.desal.flink.reportcard.ReportCardFunction.ShiftReportOut;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Drives {@link ReportCardFunction} through Flink's keyed two-input test harness with records
 * shaped like the docs/streaming-notes.md examples (shift 2 of a game: ticks 721..1440, target
 * 4056 m3, shiftEnd product 4163.88 m3).
 */
class ReportCardFunctionTest {
  private static final String GAME = "8f14e45f-ceea-467a-9575-1f2b0c6e4a11";
  private static final String RUN = "3b9d6f0e-51c2-4d7a-9f3e-2a8c1d4e6b70";
  private static final long SHIFT2_START = 721;
  private static final long SHIFT2_END = 1440;
  private static final double EPS = 1e-9;

  private KeyedTwoInputStreamOperatorTestHarness<String, Input, Input, ShiftReportOut> harness;
  private long seq;

  @BeforeEach
  void open() throws Exception {
    harness = newHarness();
    seq = 0;
  }

  @AfterEach
  void close() throws Exception {
    harness.close();
  }

  @Test
  void oneShiftGivesOneReportWithTheSummaryTotals() throws Exception {
    gameStart(0, null);
    shift2WithAPumpTrip();
    List<ShiftReport> reports = reports();
    assertEquals(1, reports.size());
    ShiftReport r = reports.get(0);
    assertEquals(4163.88, r.productM3, EPS);
    assertEquals(4056, r.targetM3, EPS);
    assertEquals(2, r.shiftId);
    assertEquals(0, r.epoch);
    assertEquals("normal", r.mode);
    assertEquals(1, r.events.size());
    assertEquals("quick", r.events.get(0).verdict);
    assertEquals(GAME, harness.extractOutputValues().get(0).gameId);
    assertNull(r.vsPrevious);
  }

  @Test
  void aShiftEndDeliveredTwiceGivesOneReport() throws Exception {
    gameStart(0, null);
    ObjectNode start = shiftStartRecord(0, SHIFT2_START, 2);
    send(start, 1);
    status(0, 999, "running", 2, 2000, 2);
    ObjectNode trip = scenario(0, 1000, 2, 1, "pumpTrip");
    send(trip, 1);
    status(0, 1003, "running", 2, 2010, 1);
    status(0, 1006, "running", 2, 2020, 2);
    status(0, 1008, "running", 2, 2030, 1);
    // An at-least-once resend of records that had already got through (same epoch and seq): if
    // applied, the shiftStart would reset the shift and the pump trip would lose its response.
    send(start, 2);
    send(trip, 2);
    ObjectNode end = shiftEnd(0, SHIFT2_END, 2, 4163.88);
    send(end, 3);
    send(end, 4);
    status(0, SHIFT2_END, "handover", 2, 4163.88, 2);
    List<ShiftReport> reports = reports();
    assertEquals(1, reports.size());
    assertEquals("quick", reports.get(0).events.get(0).verdict);
  }

  @Test
  void anEpochRewindReplaysTheShiftFromTheSnapshot() throws Exception {
    gameStart(0, null);
    shiftStart(0, SHIFT2_START, 2);
    for (long t = SHIFT2_START; t <= 1200; t++) {
      if (t == 1180) {
        send(scenario(0, t, 2, 1, "pumpTrip"), 1);
      }
      status(0, t, "running", 2, (t - 720) * 5.0, t >= 1180 && t < 1190 ? 1 : 2);
    }
    // The simulator crashed; it restores the snapshot taken at tick 1170, so epoch 1 resumes at
    // tick 1171, re-fires the pump trip at 1175 and reuses seq values epoch 0 already used.
    seq = 2;
    for (long t = 1171; t <= SHIFT2_END - 1; t++) {
      if (t == 1175) {
        send(scenario(1, t, 2, 1, "pumpTrip"), 1);
      }
      status(1, t, "running", 2, (t - 720) * 4.0, t >= 1175 && t < 1178 ? 1 : 2);
      if (t == 1260) {
        status(0, t, "running", 2, 99999, 2); // a late epoch-0 status: stale, ignored
      }
    }
    send(shiftEnd(1, SHIFT2_END, 2, 4163.88), 1);
    status(1, SHIFT2_END, "handover", 2, 4163.88, 2);

    List<ShiftReport> reports = reports();
    assertEquals(1, reports.size());
    ShiftReport r = reports.get(0);
    assertEquals(1, r.epoch);
    assertEquals(1, r.events.size());
    EventLine e = r.events.get(0);
    assertEquals((1175 - SHIFT2_START) * 2.0 / 3, e.atMinute, EPS);
    assertEquals(2.0, e.responseMinutes, EPS); // pumps back at 1178
    // Hour 5 ends at tick 1170 (the snapshot): its point is epoch 0's. Hours 6 and 7 come from
    // epoch 1's statuses, the last of each hour (ticks 1260 and 1350).
    assertEquals(450 * 5.0, pace(r, 5), EPS);
    assertEquals(540 * 4.0, pace(r, 6), EPS);
    assertEquals(630 * 4.0, pace(r, 7), EPS);
    assertEquals(4163.88, pace(r, 8), EPS);
  }

  @Test
  void aGamePausedAtTheSnapshotKeepsWhatHappenedAtThatTick() throws Exception {
    gameStart(0, null);
    shiftStart(0, SHIFT2_START, 2);
    for (long t = SHIFT2_START; t <= 1000; t++) {
      if (t == 1000) {
        send(scenario(0, t, 2, 1, "pumpTrip"), 1);
      }
      status(0, t, "running", 2, 0, t == 1000 ? 1 : 2);
    }
    status(0, 1000, "paused", 2, 0, 1);
    // Restored from the snapshot at 1000 while paused: the event fired at 1000 is in the snapshot
    // and is not fired again; the first epoch-1 status is stamped at 1000 itself.
    status(1, 1000, "paused", 2, 0, 1);
    for (long t = 1001; t <= 1003; t++) {
      status(1, t, "running", 2, 0, t == 1003 ? 2 : 1);
    }
    send(shiftEnd(1, SHIFT2_END, 2, 4163.88), 1);
    status(1, SHIFT2_END, "handover", 2, 4163.88, 2);
    ShiftReport r = reports().get(0);
    assertEquals(1, r.events.size());
    assertEquals(2.0, r.events.get(0).responseMinutes, EPS);
  }

  @Test
  void hostEventsAreIgnored() throws Exception {
    gameStart(0, null);
    shiftStart(0, SHIFT2_START, 2);
    ObjectNode host = event(9, 0, "gameEnd");
    host.put("host", true);
    host.put("seq", 0);
    host.put("callSign", "Kestrel-42");
    host.put("runId", RUN);
    host.put("reason", "quit");
    host.set("score", score(0, 0));
    send(host, 1);
    send(shiftEnd(0, SHIFT2_END, 2, 4163.88), 2);
    status(0, SHIFT2_END, "handover", 2, 4163.88, 2);
    assertEquals(1, reports().size());
    assertEquals(0, reports().get(0).epoch);
    assertTrue(runResults().isEmpty());
  }

  @Test
  void gameEndMidShiftGivesARunResultAndNoReport() throws Exception {
    gameStart(0, null);
    // Shift 1: the pump trip is never answered (missed).
    shiftStart(0, 1, 1);
    send(scenario(0, 100, 1, 1, "pumpTrip"), 1);
    status(0, 101, "running", 1, 10, 1);
    send(shiftEnd(0, 720, 1, 3000), 1);
    status(0, 720, "handover", 1, 3000, 2);
    // Shift 2: answered in 4 minutes (quick).
    shift2WithAPumpTrip();
    // Shift 3: a tube leak is still open when the game ends.
    shiftStart(0, 1441, 3);
    send(scenario(0, 1500, 3, 1, "tubeLeak"), 1);
    ObjectNode end = event(0, 1510, "gameEnd");
    end.put("callSign", "Kestrel-42");
    end.put("runId", RUN);
    end.put("mode", "normal");
    end.put("reason", "bankrupt");
    end.set("score", score(2, 7300));
    send(end, 1_790_000_000_000L);
    // After gameEnd, records are ignored.
    send(shiftEnd(0, 2160, 3, 1), 1_790_000_000_001L);
    status(0, 1510, "over", 3, 0, 0);

    List<ShiftReport> reports = reports();
    assertEquals(2, reports.size());
    assertEquals(1, reports.get(1).vsPrevious.shiftId);

    List<RunResult> results = runResults();
    assertEquals(1, results.size());
    RunResult run = results.get(0);
    assertEquals(RUN, run.runId);
    assertEquals("Kestrel-42", run.callSign);
    assertEquals("normal", run.mode);
    assertEquals(1_790_000_000_000L, run.endedAt);
    assertEquals(2, run.shiftsCompleted);
    assertEquals(7300, run.totalProductM3, EPS);
    assertEquals("bankrupt", run.endReason);
    KindStat pumpTrip = kind(run, "pumpTrip");
    assertEquals(2, pumpTrip.count);
    assertEquals(1, pumpTrip.handledWell);
    assertFalse(pumpTrip.firstHandledWell);
    assertEquals(4.0, pumpTrip.meanResponseMinutes, EPS);
    KindStat tubeLeak = kind(run, "tubeLeak");
    assertEquals(1, tubeLeak.count);
    assertEquals(0, tubeLeak.handledWell);
    assertNull(tubeLeak.meanResponseMinutes);
  }

  @Test
  void aHardGameSeenOnlyFromItsGameEndIsFiledAsHard() throws Exception {
    // The job starts reading at the very end: no gameStart, and the status handler finishes the
    // game before it would copy the status's mode.
    ObjectNode end = event(0, 1510, "gameEnd");
    end.put("callSign", "Kestrel-42");
    end.put("runId", RUN);
    end.put("mode", "hard");
    end.put("reason", "bankrupt");
    end.set("score", score(2, 7300));
    send(end, 1_790_000_000_000L);
    sendStatus(harness, statusRecord(0, 1510, "over", 3, 0, 0, 2.0).put("mode", "hard"));

    List<RunResult> results = runResults();
    assertEquals(1, results.size());
    assertEquals("hard", results.get(0).mode);
  }

  @Test
  void aHardGameCarriesItsModeAndNotesTheEarthquake() throws Exception {
    gameStart(0, "hard");
    shiftStart(0, SHIFT2_START, 2);
    status(0, 999, "running", 2, 100, 2);
    send(scenario(0, 1000, 2, 1, "earthquake"), 1);
    send(scenario(0, 1000, 2, 2, "pumpTrip"), 1); // the earthquake's cascaded child
    send(cleared(0, 1000, 2, 1, "earthquake", "noted"), 1);
    status(0, 1001, "running", 2, 100, 1);
    status(0, 1003, "running", 2, 100, 2);
    send(shiftEnd(0, SHIFT2_END, 2, 4163.88), 1);
    ObjectNode end = event(0, SHIFT2_END, "gameEnd");
    end.put("callSign", "Kestrel-42");
    end.put("runId", RUN);
    end.put("mode", "hard");
    end.put("reason", "quit");
    end.set("score", score(1, 4163.88));
    send(end, 5);
    status(0, SHIFT2_END, "over", 2, 4163.88, 2);

    ShiftReport r = reports().get(0);
    assertEquals("hard", r.mode);
    EventLine quake = r.events.get(0);
    assertEquals("earthquake", quake.kind);
    assertEquals("noted", quake.outcome);
    assertNull(quake.verdict);
    EventLine child = r.events.get(1);
    assertEquals("pumpTrip", child.kind);
    assertEquals("quick", child.verdict);

    RunResult run = runResults().get(0);
    assertEquals("hard", run.mode);
    KindStat q = kind(run, "earthquake");
    assertEquals(1, q.count);
    assertEquals(0, q.handledWell);
    assertFalse(q.firstHandledWell);
    assertNull(q.meanResponseMinutes);
    KindStat p = kind(run, "pumpTrip");
    assertEquals(1, p.handledWell);
    assertTrue(p.firstHandledWell);
  }

  /**
   * A backlog of three shifts: every event (all three shiftEnds included) is read before any
   * status. Each report still credits its response from its own later statuses and takes its pace
   * from them, and the reports are identical to those from the simulator's own order.
   */
  @Test
  void threeShiftsOfEventsAheadOfTheirStatusesGiveTheSameReportsAsInOrder() throws Exception {
    List<ObjectNode> events = new ArrayList<>();
    List<ObjectNode> statuses = new ArrayList<>();
    List<ObjectNode> inOrder = new ArrayList<>(); // events of a tick, then its status
    ObjectNode start = event(0, 0, "gameStart");
    start.put("callSign", "Kestrel-42");
    events.add(start);
    inOrder.add(start);
    for (int k = 1; k <= 3; k++) {
      long first = (k - 1) * 720L + 1;
      long last = k * 720L;
      long fire = first + 279;
      for (long t = first; t <= last; t++) {
        List<ObjectNode> at = new ArrayList<>();
        if (t == first) {
          at.add(shiftStartRecord(0, t, k));
        }
        if (t == fire) {
          at.add(scenario(0, t, k, 1, "pumpTrip"));
        }
        if (t == fire + 10) {
          at.add(cleared(0, t, k, 1, "pumpTrip", "player"));
        }
        if (t == last) {
          at.add(shiftEnd(0, t, k, 3000 + k));
        }
        ObjectNode st = statusRecord(0, t, "running", k, (t - first + 1) * 5.0, t >= fire && t < fire + 6 ? 1 : 2, 2.0);
        events.addAll(at);
        statuses.add(st);
        inOrder.addAll(at);
        inOrder.add(st);
      }
    }
    for (ObjectNode e : events) {
      sendEvent(harness, e);
    }
    assertTrue(reports().isEmpty());
    for (ObjectNode st : statuses) {
      sendStatus(harness, st);
    }
    List<ShiftReport> reports = reports();
    assertEquals(3, reports.size());
    for (int k = 1; k <= 3; k++) {
      ShiftReport r = reports.get(k - 1);
      assertEquals(k, r.shiftId);
      assertEquals(4.0, r.events.get(0).responseMinutes, EPS);
      assertEquals("quick", r.events.get(0).verdict);
      assertEquals(8, r.pace.size());
      for (int h = 1; h <= 7; h++) {
        assertEquals(90.0 * h * 5, pace(r, h), EPS);
      }
      assertEquals(3000 + k, pace(r, 8), EPS);
    }

    KeyedTwoInputStreamOperatorTestHarness<String, Input, Input, ShiftReportOut> ordered = newHarness();
    try {
      for (ObjectNode x : inOrder) {
        if (x.has("type")) {
          sendEvent(ordered, x);
        } else {
          sendStatus(ordered, x);
        }
      }
      List<ShiftReport> expected = new ArrayList<>();
      for (ShiftReportOut o : ordered.extractOutputValues()) {
        expected.add(o.report);
      }
      assertEquals(3, expected.size());
      assertEquals(Json.MAPPER.writeValueAsString(expected), Json.MAPPER.writeValueAsString(reports));
    } finally {
      ordered.close();
    }
  }

  /**
   * Events of both epochs read before the statuses: the epoch-0 event after the snapshot (tick
   * 1170) is dropped when epoch 1's re-fired copy arrives; the one before it is applied with
   * epoch 0's statuses.
   */
  @Test
  void anEpochChangeWhileEventsAreBufferedKeepsWhatIsInTheSnapshot() throws Exception {
    gameStart(0, null);
    shiftStart(0, SHIFT2_START, 2);
    send(scenario(0, 900, 2, 1, "pumpTrip"), 1);
    send(scenario(0, 1180, 2, 2, "powerDip"), 1);
    seq = 2;
    send(scenario(1, 1175, 2, 2, "powerDip"), 1);
    send(shiftEnd(1, SHIFT2_END, 2, 4163.88), 1);
    for (long t = SHIFT2_START; t <= 1100; t++) {
      status(0, t, "running", 2, 0, t >= 900 && t < 903 ? 1 : 2);
    }
    for (long t = 1171; t <= SHIFT2_END; t++) {
      status(1, t, "running", 2, 0, t >= 1175 && t < 1178 ? 1 : 2);
    }
    List<ShiftReport> reports = reports();
    assertEquals(1, reports.size());
    ShiftReport r = reports.get(0);
    assertEquals(1, r.epoch);
    assertEquals(2, r.events.size());
    assertEquals(2.0, r.events.get(0).responseMinutes, EPS);
    EventLine dip = r.events.get(1);
    assertEquals((1175 - SHIFT2_START) * 2.0 / 3, dip.atMinute, EPS);
    assertEquals(2.0, dip.responseMinutes, EPS);
  }

  /** A bloom read before the statuses around it takes the dose at its fire tick, not an old one. */
  @Test
  void aBloomReadAheadOfStatusTakesTheDoseAtItsFireTick() throws Exception {
    gameStart(0, null);
    sendStatus(harness, statusRecord(0, 700, "handover", 1, 0, 2, 3.0));
    shiftStart(0, SHIFT2_START, 2);
    send(scenario(0, 1000, 2, 1, "bloom"), 1);
    for (long t = SHIFT2_START; t <= 1010; t++) {
      sendStatus(harness, statusRecord(0, t, "running", 2, 0, 2, t >= 1003 ? 2.5 : 2.0));
    }
    send(shiftEnd(0, SHIFT2_END, 2, 4163.88), 1);
    status(0, SHIFT2_END, "handover", 2, 4163.88, 2);
    EventLine bloom = reports().get(0).events.get(0);
    assertEquals(2.0, bloom.responseMinutes, EPS);
    assertEquals("quick", bloom.verdict);
  }

  /** lowSteam is answered by the standby line: status T+3 with it on is 2 plant minutes. */
  @Test
  void aLowSteamAnsweredByTheStandbyLineIsGradedQuick() throws Exception {
    gameStart(0, null);
    sendStatus(harness, statusRecord(0, 700, "handover", 1, 0, 2, 3.0));
    shiftStart(0, SHIFT2_START, 2);
    send(scenario(0, 1000, 2, 1, "lowSteam"), 1);
    for (long t = SHIFT2_START; t <= 1010; t++) {
      ObjectNode st = statusRecord(0, t, "running", 2, 0, 2, 2.0);
      st.put("standbySteam", t >= 1003);
      sendStatus(harness, st);
    }
    send(shiftEnd(0, SHIFT2_END, 2, 4163.88), 1);
    status(0, SHIFT2_END, "handover", 2, 4163.88, 2);
    EventLine e = reports().get(0).events.get(0);
    assertEquals("lowSteam", e.kind);
    assertEquals(2.0, e.responseMinutes, EPS);
    assertEquals("quick", e.verdict);
  }

  @Test
  void aLowSteamWithNoStandbyLineIsMissed() throws Exception {
    gameStart(0, null);
    sendStatus(harness, statusRecord(0, 700, "handover", 1, 0, 2, 3.0));
    shiftStart(0, SHIFT2_START, 2);
    send(scenario(0, 1000, 2, 1, "lowSteam"), 1);
    for (long t = SHIFT2_START; t <= 1010; t++) {
      sendStatus(harness, statusRecord(0, t, "running", 2, 0, 2, 2.0));
    }
    send(shiftEnd(0, SHIFT2_END, 2, 4163.88), 1);
    status(0, SHIFT2_END, "handover", 2, 4163.88, 2);
    EventLine e = reports().get(0).events.get(0);
    assertEquals("missed", e.verdict);
  }

  /** Buffered events are flushed once the game's status has made no progress for 15 s. */
  @Test
  void bufferedEventsAreReleasedWhenStatusStops() throws Exception {
    gameStart(0, null);
    shiftStart(0, SHIFT2_START, 2);
    status(0, 999, "running", 2, 2000, 2);
    send(scenario(0, 1000, 2, 1, "pumpTrip"), 1);
    send(shiftEnd(0, SHIFT2_END, 2, 4163.88), 1);
    harness.setProcessingTime(10_000);
    status(0, 1003, "running", 2, 2010, 2); // progress: releases the pump trip, pushes the flush back
    harness.setProcessingTime(ReportCardFunction.PENDING_END_TIMEOUT_MS);
    assertTrue(reports().isEmpty());
    harness.setProcessingTime(10_000 + ReportCardFunction.PENDING_END_TIMEOUT_MS);
    List<ShiftReport> reports = reports();
    assertEquals(1, reports.size());
    assertEquals(2.0, reports.get(0).events.get(0).responseMinutes, EPS);
  }

  @Test
  void aShiftEndWithNoStatusIsFinishedAfterTheTimeout() throws Exception {
    gameStart(0, null);
    shiftStart(0, SHIFT2_START, 2);
    send(shiftEnd(0, SHIFT2_END, 2, 4163.88), 1);
    harness.setProcessingTime(ReportCardFunction.PENDING_END_TIMEOUT_MS - 1);
    assertTrue(reports().isEmpty());
    harness.setProcessingTime(ReportCardFunction.PENDING_END_TIMEOUT_MS);
    assertEquals(1, reports().size());
    assertEquals(4163.88, reports().get(0).productM3, EPS);
  }

  @Test
  void aGameEndWithNoStatusIsFinishedAfterTheTimeout() throws Exception {
    gameStart(0, null);
    shiftStart(0, SHIFT2_START, 2);
    send(scenario(0, 1000, 2, 1, "tubeLeak"), 1);
    ObjectNode end = event(0, 1100, "gameEnd");
    end.put("callSign", "Kestrel-42");
    end.put("runId", RUN);
    end.put("reason", "quit");
    end.set("score", score(1, 4000));
    send(end, 77);
    harness.setProcessingTime(ReportCardFunction.PENDING_END_TIMEOUT_MS - 1);
    assertTrue(runResults().isEmpty());
    harness.setProcessingTime(ReportCardFunction.PENDING_END_TIMEOUT_MS);
    List<RunResult> results = runResults();
    assertEquals(1, results.size());
    assertEquals(77, results.get(0).endedAt);
    assertEquals(1, kind(results.get(0), "tubeLeak").count);
    assertTrue(reports().isEmpty());
  }

  @Test
  void aDuplicateShiftEndWhilePendingGivesOneReport() throws Exception {
    gameStart(0, null);
    shiftStart(0, SHIFT2_START, 2);
    ObjectNode end = shiftEnd(0, SHIFT2_END, 2, 4163.88);
    send(end, 1);
    send(end, 2);
    status(0, SHIFT2_END, "handover", 2, 4163.88, 2);
    harness.setProcessingTime(ReportCardFunction.PENDING_END_TIMEOUT_MS * 2);
    assertEquals(1, reports().size());
  }

  @Test
  void aGameStartWithoutModeIsNormal() throws Exception {
    gameStart(0, null);
    shiftStart(0, SHIFT2_START, 2);
    send(shiftEnd(0, SHIFT2_END, 2, 4163.88), 1);
    status(0, SHIFT2_END, "handover", 2, 4163.88, 2);
    assertEquals("normal", reports().get(0).mode);
  }

  /** Keyed state is a POJO serialized without Kryo, so savepoints can evolve with the class. */
  @Test
  void gameStateIsAPojo() {
    assertTrue(TypeInformation.of(GameState.class) instanceof PojoTypeInfo);
    PojoTestUtils.assertSerializedAsPojoWithoutKryo(GameState.class);
    PojoTestUtils.assertSerializedAsPojoWithoutKryo(Input.class);
    PojoTestUtils.assertSerializedAsPojoWithoutKryo(ShiftReportOut.class);
  }

  @Test
  void theDeserializerSkipsNullValuesAndInvalidJson() throws Exception {
    Input.Deserializer d = new Input.Deserializer();
    List<Input> out = new ArrayList<>();
    Collector<Input> collect = new Collector<>() {
      @Override public void collect(Input i) {
        out.add(i);
      }

      @Override public void close() {}
    };
    d.deserialize(record(GAME, null, 1), collect);
    d.deserialize(record(GAME, "{not json", 2), collect);
    d.deserialize(record(GAME, "{\"type\":\"online\"}", 3), collect);
    assertEquals(1, out.size());
    assertEquals(GAME, out.get(0).gameId);
    assertEquals("{\"type\":\"online\"}", out.get(0).json);
    assertEquals(3, out.get(0).timestamp);
  }

  // --- the shift every test can reuse -------------------------------------------------------

  /** Shift 2: a pump trip at 1000, two pumps back at 1006 (4 minutes, quick), cleared at 1010. */
  private void shift2WithAPumpTrip() throws Exception {
    shiftStart(0, SHIFT2_START, 2);
    status(0, 999, "running", 2, 2000, 2);
    send(scenario(0, 1000, 2, 1, "pumpTrip"), 1);
    status(0, 1003, "running", 2, 2010, 1);
    status(0, 1006, "running", 2, 2020, 2);
    send(cleared(0, 1010, 2, 1, "pumpTrip", "player"), 1);
    send(shiftEnd(0, SHIFT2_END, 2, 4163.88), 1);
    status(0, SHIFT2_END, "handover", 2, 4163.88, 2);
  }

  // --- record builders ----------------------------------------------------------------------

  private ObjectNode event(int epoch, long tick, String type) {
    ObjectNode e = Json.MAPPER.createObjectNode();
    e.put("gameId", GAME);
    e.put("epoch", epoch);
    e.put("seq", ++seq);
    e.put("tick", tick);
    e.put("plantTime", tick * 40_000);
    e.put("type", type);
    return e;
  }

  private void gameStart(int epoch, String mode) throws Exception {
    ObjectNode e = event(epoch, 0, "gameStart");
    e.putNull("shiftId");
    e.put("callSign", "Kestrel-42");
    if (mode != null) {
      e.put("mode", mode);
    }
    send(e, 1);
  }

  private void shiftStart(int epoch, long tick, int shiftId) throws Exception {
    send(shiftStartRecord(epoch, tick, shiftId), 1);
  }

  private ObjectNode shiftStartRecord(int epoch, long tick, int shiftId) {
    ObjectNode e = event(epoch, tick, "shiftStart");
    e.put("shiftId", shiftId);
    e.put("scenarioId", "shift-" + shiftId);
    e.put("mode", "auto");
    ObjectNode target = e.putObject("target");
    target.put("productM3", 4056);
    target.put("maxSalinityPpm", 25);
    target.put("fuelBudgetUsd", 12480);
    e.put("hell", false);
    return e;
  }

  private ObjectNode scenario(int epoch, long tick, int shiftId, int eventId, String kind) {
    ObjectNode e = event(epoch, tick, "scenario");
    e.put("shiftId", shiftId);
    e.put("eventId", eventId);
    e.put("kind", kind);
    e.put("message", "Control, a " + kind + "!");
    e.put("radio", "Control, a " + kind + "!");
    return e;
  }

  private ObjectNode cleared(int epoch, long tick, int shiftId, int eventId, String kind, String how) {
    ObjectNode e = event(epoch, tick, "eventCleared");
    e.put("shiftId", shiftId);
    e.put("eventId", eventId);
    e.put("kind", kind);
    e.put("how", how);
    return e;
  }

  private ObjectNode shiftEnd(int epoch, long tick, int shiftId, double productM3) {
    ObjectNode e = event(epoch, tick, "shiftEnd");
    e.put("shiftId", shiftId);
    e.put("runId", RUN);
    ObjectNode s = e.putObject("summary");
    s.put("productM3", productM3);
    s.put("targetM3", 4056);
    s.put("offSpecMinutes", 0);
    s.put("offSpecM3", 0);
    s.put("fuelCostUsd", 9829.24);
    s.put("fuelBudgetUsd", 12480);
    s.put("trips", 0);
    s.put("spentUsd", 12349.24);
    s.put("nextAllocationUsd", 10340);
    s.put("balanceUsd", 13373.09);
    s.put("hell", false);
    s.putArray("events");
    return e;
  }

  private static ObjectNode score(int shiftsCompleted, double totalProductM3) {
    ObjectNode s = Json.MAPPER.createObjectNode();
    s.put("shiftsCompleted", shiftsCompleted);
    s.put("totalProductM3", totalProductM3);
    s.put("balanceUsd", -10);
    return s;
  }

  /** A plant.status record (only the fields the job reads, plus pace, which it ignores). */
  private void status(int epoch, long tick, String phase, int shiftId, double shiftProductM3, int pumps)
      throws Exception {
    sendStatus(harness, statusRecord(epoch, tick, phase, shiftId, shiftProductM3, pumps, 2.0));
  }

  private static ObjectNode statusRecord(int epoch, long tick, String phase, int shiftId, double shiftProductM3,
      int pumps, double chlorineMgL) {
    ObjectNode s = Json.MAPPER.createObjectNode();
    s.put("gameId", GAME);
    s.put("epoch", epoch);
    s.put("tick", tick);
    s.put("shiftId", shiftId);
    s.put("callSign", "Kestrel-42");
    s.put("mode", "normal");
    s.put("phase", phase);
    s.put("status", "online");
    ObjectNode p = s.putObject("pumps"); // PlantStatus.pumps: a record keyed by pump id
    for (int i = 0; i < 3; i++) {
      p.putObject("P-10" + (i + 1)).put("running", i < pumps).put("overhaulRemainingTicks", 0);
    }
    s.putObject("loops");
    s.putObject("doses").put("chlorineMgL", chlorineMgL);
    s.putNull("crew");
    s.put("shiftProductM3", shiftProductM3);
    s.putObject("pace").put("productM3h", 500);
    return s;
  }

  private static void sendStatus(KeyedTwoInputStreamOperatorTestHarness<String, Input, Input, ShiftReportOut> h,
      ObjectNode s) throws Exception {
    long tick = s.path("tick").asLong();
    h.processElement2(new StreamRecord<>(new Input(GAME, s.toString(), tick), tick));
  }

  private static void sendEvent(KeyedTwoInputStreamOperatorTestHarness<String, Input, Input, ShiftReportOut> h,
      ObjectNode e) throws Exception {
    h.processElement1(new StreamRecord<>(new Input(GAME, e.toString(), 1), 1));
  }

  private static KeyedTwoInputStreamOperatorTestHarness<String, Input, Input, ShiftReportOut> newHarness()
      throws Exception {
    return ProcessFunctionTestHarnesses.forKeyedCoProcessFunction(
        new ReportCardFunction(), i -> i.gameId, i -> i.gameId, Types.STRING);
  }

  private void send(ObjectNode event, long timestamp) throws Exception {
    harness.processElement1(new StreamRecord<>(new Input(GAME, event.toString(), timestamp), timestamp));
  }

  private static ConsumerRecord<byte[], byte[]> record(String key, String value, long timestamp) {
    byte[] k = key.getBytes(StandardCharsets.UTF_8);
    byte[] v = value == null ? null : value.getBytes(StandardCharsets.UTF_8);
    return new ConsumerRecord<>("plant.events", 0, 0, timestamp, TimestampType.LOG_APPEND_TIME,
        k.length, v == null ? -1 : v.length, k, v, new RecordHeaders(), Optional.empty());
  }

  // --- output -------------------------------------------------------------------------------

  private List<ShiftReport> reports() {
    List<ShiftReport> out = new ArrayList<>();
    for (ShiftReportOut o : harness.extractOutputValues()) {
      out.add(o.report);
    }
    return out;
  }

  private List<RunResult> runResults() {
    List<RunResult> out = new ArrayList<>();
    ConcurrentLinkedQueue<StreamRecord<RunResult>> side = harness.getSideOutput(ReportCardFunction.RUN_RESULTS);
    if (side != null) {
      for (StreamRecord<RunResult> r : side) {
        out.add(r.getValue());
      }
    }
    return out;
  }

  private static double pace(ShiftReport r, int hour) {
    for (PacePoint p : r.pace) {
      if (p.hour == hour) {
        return p.productM3;
      }
    }
    throw new AssertionError("no pace point for hour " + hour);
  }

  private static KindStat kind(RunResult run, String kind) {
    for (KindStat k : run.kinds) {
      if (k.kind.equals(kind)) {
        return k;
      }
    }
    throw new AssertionError("no kind " + kind + " in " + run.kinds.size() + " kinds");
  }
}
