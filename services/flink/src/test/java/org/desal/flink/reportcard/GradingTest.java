package org.desal.flink.reportcard;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class GradingTest {

  @Test
  void anEngagedShiftGetsBOrBetter() {
    // The engaged bot's shift 2 from docs/streaming-notes.md: 4163.88 of 4056 m3, no trips.
    double score = Grading.score(4163.88, 4056, List.of("quick", "ok"), 0, 0);
    assertTrue(score >= 80, "score " + score);
    String grade = Grading.grade(score);
    assertTrue(grade.equals("A") || grade.equals("B"), grade);
  }

  @Test
  void anUntouchedShiftGetsDOrWorse() {
    String grade = Grading.grade(Grading.score(3650, 4056, List.of("missed"), 0, 0));
    assertTrue(grade.equals("D") || grade.equals("F"), grade);
  }

  @Test
  void theFormula() {
    // 50 * clamp((90 - 50) / 50) + 30 * mean(1, 0) + 20 * clamp(1 - 0.5 * 1 - 30 / 120)
    assertEquals(40 + 15 + 5, Grading.score(900, 1000, List.of("quick", "missed"), 1, 30), 1e-9);
    // No verdicts: full event marks; below half the target: no target marks; clean score floors at 0.
    assertEquals(0 + 30 + 0, Grading.score(400, 1000, List.of(), 3, 0), 1e-9);
    assertEquals(50 + 30 * (0.75 + 0.35) / 2 + 20, Grading.score(1200, 1000, List.of("ok", "slow"), 0, 0), 1e-9);
  }

  @Test
  void gradeBands() {
    assertEquals("A", Grading.grade(90));
    assertEquals("B", Grading.grade(89.99));
    assertEquals("B", Grading.grade(80));
    assertEquals("C", Grading.grade(65));
    assertEquals("D", Grading.grade(50));
    assertEquals("F", Grading.grade(49.9));
  }
}
