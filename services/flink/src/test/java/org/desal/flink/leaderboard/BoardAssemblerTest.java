package org.desal.flink.leaderboard;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.streaming.runtime.streamrecord.StreamRecord;
import org.apache.flink.streaming.util.KeyedOneInputStreamOperatorTestHarness;
import org.apache.flink.streaming.util.ProcessFunctionTestHarnesses;
import org.desal.flink.model.KindShare;
import org.desal.flink.model.Leaderboard;
import org.desal.flink.model.LeaderboardRow;
import org.desal.flink.model.RunRank;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Drives {@link BoardAssembler} through Flink's keyed one-input test harness. The harness owns
 * processing time: nothing happens until a test moves the clock, so the 5 s throttle, the 24 h
 * "today" window and the 70 s online staleness are all exact.
 */
class BoardAssemblerTest {
  /** A wall-clock instant on 2026-11-20 (epoch ms). */
  private static final long NOW = 1_795_651_200_000L;
  private static final long HOUR = 3_600_000L;

  private KeyedOneInputStreamOperatorTestHarness<String, BoardInput, Leaderboard> harness;

  @BeforeEach
  void open() throws Exception {
    harness = ProcessFunctionTestHarnesses.forKeyedProcessFunction(new BoardAssembler(), x -> "board", Types.STRING);
    harness.setProcessingTime(NOW);
  }

  @AfterEach
  void close() throws Exception {
    harness.close();
  }

  @Test
  void theBoardHoldsTheTopTenOfTwelve() throws Exception {
    for (int i = 1; i <= 12; i++) {
      run("normal", "n" + i, 1000 - i, NOW - HOUR, i);
    }
    advance(BoardAssembler.EMIT_EVERY_MS);
    Leaderboard board = onlyBoard();
    assertEquals(10, board.normal.allTime.size());
    assertEquals(10, board.normal.today.size());
    for (int i = 0; i < 10; i++) {
      assertEquals(i + 1, board.normal.allTime.get(i).rank);
      assertEquals("n" + (i + 1), board.normal.allTime.get(i).runId);
      assertEquals("n" + (i + 1), board.normal.today.get(i).runId);
      assertEquals(i + 1, board.normal.today.get(i).rank);
    }
    assertEquals("Call-n1", board.normal.allTime.get(0).callSign);
    assertEquals(NOW + BoardAssembler.EMIT_EVERY_MS, board.updatedAt);
    assertTrue(board.hard.allTime.isEmpty());
    assertTrue(board.hard.today.isEmpty());
    assertEquals(12, ranks().size());
  }

  @Test
  void aRunThatEndedTwentyFiveHoursAgoIsAllTimeButNotToday() throws Exception {
    run("normal", "old", 2000, NOW - 25 * HOUR, 1);
    run("normal", "new", 1000, NOW - HOUR, 2);
    advance(BoardAssembler.EMIT_EVERY_MS);
    Leaderboard board = onlyBoard();
    assertEquals(List.of("old", "new"), ids(board.normal.allTime));
    assertEquals(List.of("new"), ids(board.normal.today));
    assertEquals(1, board.normal.today.get(0).rank);
    Map<String, RunRank> ranks = byRun(ranks());
    assertEquals(1, ranks.get("old").allTime);
    assertNull(ranks.get("old").today);
    assertEquals(2, ranks.get("new").allTime);
    assertEquals(1, ranks.get("new").today);
  }

  @Test
  void aRunLeavesTodayOnceItIsOlderThanTwentyFourHours() throws Exception {
    run("normal", "a", 1000, NOW - 24 * HOUR + 30_000, 1);
    advance(BoardAssembler.EMIT_EVERY_MS);
    assertEquals(1, byRun(ranks()).get("a").today);
    harness.getSideOutput(BoardAssembler.RANKS).clear();
    // Nothing changes, so the next board is the 60 s heartbeat, by which time the run is 24 h old.
    advance(BoardAssembler.HEARTBEAT_MS);
    Leaderboard board = lastBoard();
    assertTrue(board.normal.today.isEmpty());
    List<RunRank> ranks = ranks();
    assertEquals(1, ranks.size());
    assertEquals(1, ranks.get(0).allTime);
    assertNull(ranks.get(0).today);
  }

  @Test
  void ranksAreEmittedOnlyForRunsWhoseRankChanged() throws Exception {
    for (int i = 1; i <= 12; i++) {
      run("normal", "n" + i, 1000 - i, NOW - HOUR, i);
    }
    advance(BoardAssembler.EMIT_EVERY_MS);
    assertEquals(12, ranks().size());
    harness.getSideOutput(BoardAssembler.RANKS).clear();

    // A new last place: only its own rank is new.
    run("normal", "n13", 10, NOW - HOUR, 13);
    advance(BoardAssembler.EMIT_EVERY_MS);
    List<RunRank> ranks = ranks();
    assertEquals(1, ranks.size());
    assertEquals("n13", ranks.get(0).runId);
    assertEquals(13, ranks.get(0).allTime);
    assertEquals(13, ranks.get(0).today);
    harness.getSideOutput(BoardAssembler.RANKS).clear();

    // n12 overtakes n11, the way the Top-N changelog reports it: each rank position is retracted
    // and then filled again.
    retractRun("normal", "n11", 989, NOW - HOUR, 11);
    run("normal", "n12", 988, NOW - HOUR, 11);
    retractRun("normal", "n12", 988, NOW - HOUR, 12);
    run("normal", "n11", 989, NOW - HOUR, 12);
    advance(BoardAssembler.EMIT_EVERY_MS);
    Map<String, RunRank> changed = byRun(ranks());
    assertEquals(2, changed.size());
    assertEquals(11, changed.get("n12").allTime);
    assertEquals(12, changed.get("n11").allTime);
  }

  @Test
  void aRetractionThatNoLongerMatchesKeepsTheNewerRow() throws Exception {
    run("normal", "a", 1000, NOW - HOUR, 1);
    run("normal", "b", 900, NOW - HOUR, 2);
    // a is deleted: b moves up to 1 before its old rank-2 row is retracted.
    retractRun("normal", "a", 1000, NOW - HOUR, 1);
    run("normal", "b", 900, NOW - HOUR, 1);
    retractRun("normal", "b", 900, NOW - HOUR, 2);
    advance(BoardAssembler.EMIT_EVERY_MS);
    Leaderboard board = onlyBoard();
    assertEquals(List.of("b"), ids(board.normal.allTime));
    assertEquals(1, board.normal.allTime.get(0).rank);
  }

  @Test
  void withNoOnlineInputForSeventySecondsTheBoardSaysZero() throws Exception {
    harness.processElement(BoardInput.online(3), NOW);
    advance(BoardAssembler.EMIT_EVERY_MS);
    assertEquals(3, lastBoard().online);
    // Stale only after 70 s: at 65 s the last board still says 3.
    advanceTo(NOW + 65_000);
    assertEquals(3, lastBoard().online);
    advanceTo(NOW + BoardAssembler.ONLINE_STALE_MS);
    assertEquals(0, lastBoard().online);
  }

  @Test
  void aFreshOnlineCountReplacesTheOldOne() throws Exception {
    harness.processElement(BoardInput.online(3), NOW);
    harness.processElement(BoardInput.online(5), NOW);
    advance(BoardAssembler.EMIT_EVERY_MS);
    assertEquals(5, onlyBoard().online);
  }

  @Test
  void atMostOneBoardPerFiveSecondsOfProcessingTime() throws Exception {
    for (int s = 0; s < 20; s++) {
      run("normal", "n" + s, 1000 - s, NOW - HOUR, s + 1);
      advance(1_000);
    }
    // 20 s of steady input: one board per 5 s, not one per record.
    assertEquals(4, harness.extractOutputValues().size());
    // Quiet: no board until the 60 s heartbeat.
    advance(55_000);
    assertEquals(4, harness.extractOutputValues().size());
    advance(BoardAssembler.EMIT_EVERY_MS);
    assertEquals(5, harness.extractOutputValues().size());
  }

  @Test
  void statsGiveTheShareWhoHandledTheirFirstOneWell() throws Exception {
    harness.processElement(BoardInput.stat(false, "normal", "vacuumLoss", 4, 3), NOW);
    harness.processElement(BoardInput.stat(false, "normal", "pumpTrip", 3, 1), NOW);
    harness.processElement(BoardInput.stat(false, "hard", "tsunami", 2, 1), NOW);
    advance(BoardAssembler.EMIT_EVERY_MS);
    Leaderboard board = onlyBoard();
    Map<String, KindShare> normal = byKind(board.normal.stats);
    assertEquals(2, normal.size());
    assertEquals(4, normal.get("vacuumLoss").operators);
    assertEquals(75.0, normal.get("vacuumLoss").firstHandledWellPct, 1e-9);
    assertEquals(33.3, normal.get("pumpTrip").firstHandledWellPct, 1e-9);
    Map<String, KindShare> hard = byKind(board.hard.stats);
    assertEquals(1, hard.size());
    assertEquals(50.0, hard.get("tsunami").firstHandledWellPct, 1e-9);
  }

  @Test
  void aStatUpdateReplacesTheOldCountsAndADeleteRemovesTheKind() throws Exception {
    harness.processElement(BoardInput.stat(false, "normal", "vacuumLoss", 3, 2), NOW);
    harness.processElement(BoardInput.stat(true, "normal", "vacuumLoss", 3, 2), NOW);
    harness.processElement(BoardInput.stat(false, "normal", "vacuumLoss", 4, 3), NOW);
    harness.processElement(BoardInput.stat(false, "normal", "storm", 1, 1), NOW);
    harness.processElement(BoardInput.stat(true, "normal", "storm", 1, 1), NOW);
    advance(BoardAssembler.EMIT_EVERY_MS);
    Map<String, KindShare> normal = byKind(onlyBoard().normal.stats);
    assertEquals(1, normal.size());
    assertEquals(75.0, normal.get("vacuumLoss").firstHandledWellPct, 1e-9);
  }

  @Test
  void eachModeHasItsOwnBoardTodayAndRanks() throws Exception {
    run("normal", "n1", 1000, NOW - HOUR, 1);
    run("normal", "n2", 800, NOW - 2 * HOUR, 2);
    run("normal", "nOld", 700, NOW - 30 * HOUR, 3);
    run("hard", "h1", 900, NOW - 30 * HOUR, 1);
    run("hard", "h2", 600, NOW - HOUR, 2);
    advance(BoardAssembler.EMIT_EVERY_MS);
    Leaderboard board = onlyBoard();
    assertEquals(List.of("n1", "n2", "nOld"), ids(board.normal.allTime));
    assertEquals(List.of("n1", "n2"), ids(board.normal.today));
    assertEquals(List.of("h1", "h2"), ids(board.hard.allTime));
    assertEquals(List.of("h2"), ids(board.hard.today));
    assertEquals(1, board.hard.today.get(0).rank);

    Map<String, RunRank> ranks = byRun(ranks());
    assertEquals(5, ranks.size());
    assertEquals(1, ranks.get("h1").allTime);
    assertNull(ranks.get("h1").today);
    assertEquals(2, ranks.get("h2").allTime);
    assertEquals(1, ranks.get("h2").today);
    assertEquals(2, ranks.get("n2").allTime);
    assertEquals(2, ranks.get("n2").today);
  }

  @Test
  void todayIsRankedByWaterThenShiftsThenTheEarlierRun() throws Exception {
    run("normal", "late", 500, 3, NOW - HOUR, 3);
    run("normal", "early", 500, 3, NOW - 2 * HOUR, 2);
    run("normal", "moreShifts", 500, 4, NOW - HOUR, 1);
    advance(BoardAssembler.EMIT_EVERY_MS);
    assertEquals(List.of("moreShifts", "early", "late"), ids(onlyBoard().normal.today));
  }

  // --- helpers ---

  private void run(String mode, String runId, double water, long endedAt, int rank) throws Exception {
    run(mode, runId, water, 3, endedAt, rank);
  }

  private void run(String mode, String runId, double water, int shifts, long endedAt, int rank) throws Exception {
    harness.processElement(
        BoardInput.ranked(false, runId, "Call-" + runId, mode, shifts, water, endedAt, rank), NOW);
  }

  private void retractRun(String mode, String runId, double water, long endedAt, int rank) throws Exception {
    harness.processElement(BoardInput.ranked(true, runId, "Call-" + runId, mode, 3, water, endedAt, rank), NOW);
  }

  private void advance(long ms) throws Exception {
    harness.setProcessingTime(harness.getProcessingTime() + ms);
  }

  /** Moves the clock 5 s at a time, the way it moves in a running job, so every timer fires. */
  private void advanceTo(long t) throws Exception {
    while (harness.getProcessingTime() < t) {
      harness.setProcessingTime(Math.min(t, harness.getProcessingTime() + BoardAssembler.EMIT_EVERY_MS));
    }
  }

  private Leaderboard onlyBoard() {
    List<Leaderboard> boards = harness.extractOutputValues();
    assertEquals(1, boards.size());
    return boards.get(0);
  }

  private Leaderboard lastBoard() {
    List<Leaderboard> boards = harness.extractOutputValues();
    return boards.get(boards.size() - 1);
  }

  private List<RunRank> ranks() {
    ConcurrentLinkedQueue<StreamRecord<RunRank>> queue = harness.getSideOutput(BoardAssembler.RANKS);
    List<RunRank> out = new ArrayList<>();
    if (queue != null) {
      queue.forEach(r -> out.add(r.getValue()));
    }
    return out;
  }

  private static Map<String, RunRank> byRun(List<RunRank> ranks) {
    Map<String, RunRank> out = new HashMap<>();
    ranks.forEach(r -> out.put(r.runId, r));
    return out;
  }

  private static Map<String, KindShare> byKind(List<KindShare> stats) {
    Map<String, KindShare> out = new HashMap<>();
    stats.forEach(s -> out.put(s.kind, s));
    return out;
  }

  private static List<String> ids(List<LeaderboardRow> rows) {
    List<String> out = new ArrayList<>();
    rows.forEach(r -> out.add(r.runId));
    return out;
  }
}
