#!/usr/bin/env bash
# Runs Maven in Docker so the host needs no JDK or Maven. The repo root is mounted at /w
# (so tests can write the contract fixtures into packages/schema) and dependencies are cached
# in the named volume desal-m2. Usage: services/flink/mvn.sh test | package | ...
set -euo pipefail
cd "$(dirname "$0")/../.."
exec docker run --rm -v "$PWD":/w -v desal-m2:/root/.m2 -w /w/services/flink \
  maven:3.9.11-eclipse-temurin-17 mvn -B "$@"
