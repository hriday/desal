package org.desal.flink.reportcard;

import java.util.List;

/**
 * The shift's score and grade. score = 50 × target achievement + 30 × event handling + 20 × clean
 * running, each part 0..1:
 * <ul>
 *   <li>target: (pct − 50) / 50 clamped, so half the target or less scores 0 and the full target 1;</li>
 *   <li>events: mean of quick 1, ok 0.75, slow 0.35, missed 0 (1 when nothing was graded);</li>
 *   <li>clean: 1 − 0.5 per trip − off-spec minutes / 120, clamped.</li>
 * </ul>
 * Tuned so the engaged bot's shift is a B or better and an untouched shift a D or worse.
 */
public final class Grading {
  private Grading() {}

  public static double score(double productM3, double targetM3, List<String> verdicts, int trips,
      double offSpecMinutes) {
    double pct = targetM3 > 0 ? 100 * productM3 / targetM3 : 0;
    double targetScore = clamp((pct - 50) / 50);
    double eventScore = 1.0;
    if (!verdicts.isEmpty()) {
      double sum = 0;
      for (String v : verdicts) {
        sum += verdictScore(v);
      }
      eventScore = sum / verdicts.size();
    }
    double cleanScore = clamp(1 - 0.5 * trips - offSpecMinutes / 120);
    return 50 * targetScore + 30 * eventScore + 20 * cleanScore;
  }

  public static String grade(double score) {
    if (score >= 90) {
      return "A";
    }
    if (score >= 80) {
      return "B";
    }
    if (score >= 65) {
      return "C";
    }
    return score >= 50 ? "D" : "F";
  }

  private static double verdictScore(String verdict) {
    switch (verdict) {
      case "quick": return 1;
      case "ok": return 0.75;
      case "slow": return 0.35;
      default: return 0;
    }
  }

  private static double clamp(double x) {
    return Math.max(0, Math.min(1, x));
  }
}
