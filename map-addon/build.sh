#!/bin/bash
# Reproducible build of wrenmap with rootless podman (no JDK needed on the host).
# Usage: ./build.sh [gradle args]   default: clean build (compiles, runs unit tests, remaps jar)
# Output: build-out/wrenmap-<ver>.jar + .sha512
set -euo pipefail
cd "$(cd "$(dirname "$0")" && pwd)"
mkdir -p .gradle-home build-out
ARGS=("$@"); [ ${#ARGS[@]} -eq 0 ] && ARGS=(clean build)
timeout 1500 podman run --rm --userns=keep-id \
  -v "$PWD":/work:Z -w /work \
  -e GRADLE_USER_HOME=/work/.gradle-home \
  docker.io/library/gradle:8-jdk21@sha256:c71fc6625c18e889654adeb86c99974028bc888505f6e1fd7eccad057174877d \
  gradle --no-daemon --console=plain "${ARGS[@]}"
JAR=$(ls build/libs/wrenmap-*.jar | grep -v -- '-sources' | head -1)
cp -f "$JAR" build-out/
( cd build-out && sha512sum "$(basename "$JAR")" | tee "$(basename "$JAR").sha512" )
