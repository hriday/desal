# Flink image: the stock Flink 2.2.1 session-cluster image plus our jobs' jar and flink-jobs.sh.
# Build context is the repo root:
#   docker build -f services/flink/Dockerfile -t desal-flink:<commit> .
# The same image runs as the jobmanager and the taskmanager (compose `command:`). Jobs are not
# baked in as an application: deploys submit them to the running session cluster with
# flink-jobs.sh, from the savepoints taken when the previous deploy stopped them.

FROM maven:3.9.11-eclipse-temurin-17 AS build
WORKDIR /build
COPY services/flink services/flink
WORKDIR /build/services/flink
# Builds target/desal-flink.jar (both jobs; no Main-Class, so jobs are submitted with -c).
# The cache mount keeps Maven's downloads between builds on the same machine.
RUN --mount=type=cache,target=/root/.m2 mvn -B -DskipTests package

FROM flink:2.2.1-java17
# The Table planner (loader), runtime and flink-json jars this image already has in /opt/flink/lib
# are what the leaderboard job's SQL needs; the jar brings only the Kafka connector and Jackson.
COPY --from=build /build/services/flink/target/desal-flink.jar /opt/flink/usrlib/desal-flink.jar
COPY --chmod=755 services/flink/flink-jobs.sh /opt/flink/bin/flink-jobs.sh
# /flink-data is the volume both containers mount: checkpoints and savepoints must be on a path
# the jobmanager and the taskmanager both see. A fresh named volume copies this ownership.
# The base image runs as user flink; switch to root only to create the directory.
USER root
RUN mkdir -p /flink-data/checkpoints /flink-data/savepoints \
 && chown -R flink:flink /flink-data
USER flink
