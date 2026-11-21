package org.desal.flink.model;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.java.typeutils.PojoTypeInfo;
import org.desal.flink.common.Json;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * Writes one realistic instance of each record the Flink jobs produce into
 * packages/schema/test/fixtures/flink/. The TypeScript test (packages/schema/test/flink.test.ts)
 * parses those files with the zod schemas, so a field the Java side names or types differently
 * fails there: this is the contract between the jobs and the gateway/browser.
 */
class ContractFixturesTest {
  private static final Path FIXTURES = Path.of("../../packages/schema/test/fixtures/flink");
  private static final String RUN_A = "11111111-2222-4333-8444-555555555555";
  private static final String RUN_B = "66666666-7777-4888-9999-aaaaaaaaaaaa";
  private static final String RUN_C = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  private static final long ENDED_AT = 1_790_000_000_000L;

  @Test
  void writesContractFixtures() throws IOException {
    write("shift-report.json", shiftReport());
    write("run-result.json", runResult());
    write("leaderboard.json", leaderboard());
    write("run-rank.json", runRank());
  }

  /**
   * Every record is a Flink POJO (public class, public no-arg constructor, public non-final
   * fields). Flink then serializes it field by field with its PojoSerializer instead of falling
   * back to Kryo, which matters because these records are also kept as job state.
   */
  @ParameterizedTest
  @ValueSource(classes = {
      ShiftReport.class, EventLine.class, PacePoint.class, Comparison.class, RunResult.class,
      KindStat.class, Leaderboard.class, ModeBoard.class, LeaderboardRow.class, KindShare.class,
      RunRank.class})
  void isAFlinkPojo(Class<?> type) {
    TypeInformation<?> info = TypeInformation.of(type);
    assertTrue(info instanceof PojoTypeInfo, type.getSimpleName() + " is " + info);
  }

  private static void write(String name, Object record) throws IOException {
    String json = Json.MAPPER.writerWithDefaultPrettyPrinter().writeValueAsString(record) + "\n";
    Files.createDirectories(FIXTURES);
    Files.writeString(FIXTURES.resolve(name), json, StandardCharsets.UTF_8);
  }

  private static ShiftReport shiftReport() {
    ShiftReport r = new ShiftReport();
    r.shiftId = 2;
    r.epoch = 0;
    r.mode = "hard";
    r.grade = "B";
    r.score = 74.5;
    r.targetM3 = 1500;
    r.productM3 = 1320;
    r.offSpecM3 = 12;
    r.offSpecMinutes = 4;
    r.trips = 1;
    r.spentUsd = 900;
    r.minutesTripped = 6.5;
    r.self = comparison(2, 88, 2, 3, 6.5);
    r.events = new ArrayList<>(List.of(
        // A pump trip reset 3.3 plant minutes after it fired: quick (<= 5).
        event(1, "pumpTrip", 12, 3.3, 3.3, "cleared by you", "quick"),
        // A tube leak nobody responded to before shift end: missed.
        event(2, "tubeLeak", 60, null, null, "not cleared", "missed"),
        // Fuel contamination is graded on time-to-clear: cleared after 12 minutes is ok (<= 15).
        event(3, "fuelContamination", 100, 12.0, 12.0, "cleared by you", "ok"),
        // An earthquake is only noted: no response, no verdict.
        event(4, "earthquake", 200, null, null, "noted", null)));
    double[] product = {150, 320, 500, 680, 850, 1000, 1150, 1320};
    r.pace = new ArrayList<>();
    for (int hour = 1; hour <= 8; hour++) {
      PacePoint p = new PacePoint();
      p.hour = hour;
      p.productM3 = product[hour - 1];
      p.targetM3 = 187.5 * hour;
      r.pace.add(p);
    }
    r.vsPrevious = comparison(1, 95, 2, 2, 0);
    r.vsBest = null;
    return r;
  }

  private static RunResult runResult() {
    RunResult r = new RunResult();
    r.runId = RUN_A;
    r.callSign = "Kestrel-42";
    r.mode = "hard";
    r.endedAt = ENDED_AT;
    r.shiftsCompleted = 3;
    r.totalProductM3 = 4100.5;
    r.endReason = "bankrupt";
    r.kinds = new ArrayList<>(List.of(
        kindStat("pumpTrip", 2, 1, 4.2, true),
        kindStat("storm", 1, 0, null, false)));
    return r;
  }

  private static Leaderboard leaderboard() {
    Leaderboard b = new Leaderboard();
    b.updatedAt = ENDED_AT + 60_000;
    b.online = 3;
    b.normal = new ModeBoard();
    b.normal.allTime = new ArrayList<>(List.of(
        row(1, "Kestrel-42", 5, 7200.25, ENDED_AT - 86_400_000L, RUN_B),
        row(2, "Heron-7", 3, 4100.5, ENDED_AT, RUN_C)));
    b.normal.today = new ArrayList<>(List.of(row(1, "Heron-7", 3, 4100.5, ENDED_AT, RUN_C)));
    KindShare share = new KindShare();
    share.kind = "pumpTrip";
    share.operators = 12;
    share.firstHandledWellPct = 58.3;
    b.normal.stats = new ArrayList<>(List.of(share));
    b.hard = new ModeBoard();
    b.hard.allTime = new ArrayList<>(List.of(row(1, "Kestrel-42", 3, 4100.5, ENDED_AT, RUN_A)));
    b.hard.today = new ArrayList<>();
    b.hard.stats = new ArrayList<>();
    return b;
  }

  private static RunRank runRank() {
    RunRank r = new RunRank();
    r.runId = RUN_A;
    r.allTime = 57;
    r.today = null;
    return r;
  }

  private static Comparison comparison(int shiftId, double targetPct, int well, int of, double tripped) {
    Comparison c = new Comparison();
    c.shiftId = shiftId;
    c.targetPct = targetPct;
    c.handledWell = well;
    c.handledOf = of;
    c.minutesTripped = tripped;
    return c;
  }

  private static EventLine event(int id, String kind, double at, Double response, Double clear,
      String outcome, String verdict) {
    EventLine e = new EventLine();
    e.eventId = id;
    e.kind = kind;
    e.atMinute = at;
    e.responseMinutes = response;
    e.clearMinutes = clear;
    e.outcome = outcome;
    e.verdict = verdict;
    return e;
  }

  private static KindStat kindStat(String kind, int count, int well, Double mean, boolean first) {
    KindStat k = new KindStat();
    k.kind = kind;
    k.count = count;
    k.handledWell = well;
    k.meanResponseMinutes = mean;
    k.firstHandledWell = first;
    return k;
  }

  private static LeaderboardRow row(int rank, String callSign, int shifts, double product, long endedAt,
      String runId) {
    LeaderboardRow r = new LeaderboardRow();
    r.rank = rank;
    r.callSign = callSign;
    r.shiftsCompleted = shifts;
    r.totalProductM3 = product;
    r.endedAt = endedAt;
    r.runId = runId;
    return r;
  }
}
