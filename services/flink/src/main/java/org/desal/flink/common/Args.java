package org.desal.flink.common;

/** Command-line options shared by every job: {@code --brokers host:port --topic-suffix s}. */
public final class Args {
  public static final String DEFAULT_BROKERS = "kafka:29092";

  public final String brokers;
  public final String topicSuffix;

  private Args(String brokers, String topicSuffix) {
    this.brokers = brokers;
    this.topicSuffix = topicSuffix;
  }

  /** Parses {@code --brokers} (default {@value #DEFAULT_BROKERS}) and {@code --topic-suffix} (default empty). */
  public static Args parse(String[] argv) {
    String brokers = DEFAULT_BROKERS;
    String suffix = "";
    for (int i = 0; i < argv.length; i++) {
      String flag = argv[i];
      if (!flag.equals("--brokers") && !flag.equals("--topic-suffix")) {
        throw new IllegalArgumentException("unknown option " + flag);
      }
      if (i + 1 >= argv.length) {
        throw new IllegalArgumentException(flag + " needs a value");
      }
      String value = argv[++i];
      if (flag.equals("--brokers")) {
        brokers = value;
      } else {
        suffix = value;
      }
    }
    return new Args(brokers, suffix);
  }

  /** {@code base} with this run's topic suffix. */
  public String topic(String base) {
    return Topics.name(base, topicSuffix);
  }
}
