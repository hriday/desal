package org.desal.flink.reportcard;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * The fields of one {@code plant.status} record (packages/schema/src/status.ts) that the report
 * card reads. A Flink POJO, because the latest one is kept in keyed state.
 */
public class StatusView {
  public long tick;
  public int epoch;
  /** null outside a shift. */
  public Integer shiftId;
  /** Game mode, "normal" or "hard"; "normal" when the record has none. */
  public String mode = "normal";
  /** handover, running, paused or over. */
  public String phase;
  /** Plant status kind: online, tripped, restarting or acidCleaning. */
  public String status;
  public int pumpsRunning;
  /** Loop id (tbt, makeup, level1..level23, ...) to its mode and controller fault. */
  public Map<String, Loop> loops = new HashMap<>();
  public double chlorineMgL;
  /** The crew's current job, or null when the crew is idle. */
  public String crewJob;
  /** Ticks left on the crew's job (0 when idle); it counts down one per running tick. */
  public long crewRemainingTicks;
  /** In-spec water made so far this shift (cumulative). */
  public double shiftProductM3;

  public StatusView() {}

  /** One control loop: its mode (auto or manual) and controller fault (null when healthy). */
  public static class Loop {
    public String mode;
    public String fault;

    public Loop() {}
  }

  public static StatusView from(JsonNode status) {
    StatusView s = new StatusView();
    s.tick = status.path("tick").asLong();
    s.epoch = status.path("epoch").asInt();
    JsonNode shiftId = status.path("shiftId");
    s.shiftId = shiftId.isNumber() ? shiftId.asInt() : null;
    s.mode = text(status.path("mode"), "normal");
    s.phase = text(status.path("phase"), null);
    s.status = text(status.path("status"), null);
    for (JsonNode pump : status.path("pumps")) {
      if (pump.path("running").asBoolean(false)) {
        s.pumpsRunning++;
      }
    }
    Iterator<Map.Entry<String, JsonNode>> loops = status.path("loops").fields();
    while (loops.hasNext()) {
      Map.Entry<String, JsonNode> entry = loops.next();
      Loop loop = new Loop();
      loop.mode = text(entry.getValue().path("mode"), null);
      loop.fault = text(entry.getValue().path("fault"), null);
      s.loops.put(entry.getKey(), loop);
    }
    s.chlorineMgL = status.path("doses").path("chlorineMgL").asDouble();
    s.crewJob = text(status.path("crew").path("job"), null);
    s.crewRemainingTicks = s.crewJob == null ? 0 : status.path("crew").path("remainingTicks").asLong();
    s.shiftProductM3 = status.path("shiftProductM3").asDouble();
    return s;
  }

  private static String text(JsonNode node, String fallback) {
    return node.isTextual() ? node.asText() : fallback;
  }
}
