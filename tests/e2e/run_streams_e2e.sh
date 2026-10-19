#!/bin/sh
# Streams between Alfreds (specs/035) end to end: three backends linked on their own Docker network.
#   sh tests/e2e/run_streams_e2e.sh
# Repo root is the working directory. The backend jar is built in a JDK 21 Maven container (bare mvn may be JDK 8), the
# three backends (alfred-streams-a/b/c, ports 15101-15103, data inside the containers) and their network are always
# removed at the end; the owner's running Alfred is never touched.
set -e
cd "$(dirname "$0")/../.."

PORTS="15101 15102 15103"
for port in $PORTS; do
  if docker ps --format '{{.Names}} {{.Ports}}' | grep -v '^alfred-streams-' | grep -q ":$port->"; then
    echo "port $port is already published by another container - refusing to start the streams E2E"; exit 2
  fi
done

PY=python
command -v python >/dev/null 2>&1 || PY=python3
WORK=tests/e2e/.work/streams
NET=alfred-streams-e2e
cleanup() {
  for n in a b c; do docker rm -f alfred-streams-$n >/dev/null 2>&1 || true; done
  docker network rm $NET >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

mkdir -p "$WORK"
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd):/repo" -v alfred-m2:/root/.m2 -w //repo/backend maven:3.9-eclipse-temurin-21 \
  mvn -B -q -pl backend-app -am package -Dmaven.test.skip=true
cp backend/backend-app/target/backend.jar "$WORK/backend.jar"
JAR="$(cd "$WORK" && pwd)/backend.jar"

docker network create $NET >/dev/null
i=0
for n in a b c; do
  port=$(echo $PORTS | cut -d' ' -f$((i + 1)))
  MSYS_NO_PATHCONV=1 docker run -d --name alfred-streams-$n --network $NET -p $port:5000 -v "$JAR:/app/app.jar:ro" \
    -e WEBHOOK_SECRET=test-secret -e ALFRED_NAME="Alfred $n" -e ALFRED_VERSION=e2e -e REVERSE_PROXY_ENABLED=true \
    eclipse-temurin:21-jre java -Xmx600m -jar /app/app.jar >/dev/null
  i=$((i + 1))
done
for port in $PORTS; do
  up=0
  for _ in $(seq 1 90); do
    if curl -sf "http://localhost:$port/links/hello" >/dev/null 2>&1; then up=1; break; fi
    sleep 2
  done
  if [ $up -ne 1 ]; then echo "backend on $port did not start"; docker logs --tail 80 alfred-streams-a; exit 1; fi
done

set +e
STREAMS_E2E_PORTS="15101,15102,15103" $PY tests/e2e/streams_e2e.py
status=$?
set -e
exit $status
