FROM maven:3.9-eclipse-temurin-21 AS build

WORKDIR /app

# Copy every module's pom.xml first (not the sources yet) so `dependency:go-offline`
# gets its own Docker layer - it only re-runs when a pom.xml actually changes, not on
# every source edit.
COPY pom.xml .
COPY backend-platform/pom.xml backend-platform/pom.xml
COPY backend-calls/pom.xml backend-calls/pom.xml
COPY backend-internal-calls/pom.xml backend-internal-calls/pom.xml
COPY backend-call-overlap/pom.xml backend-call-overlap/pom.xml
COPY backend-comments/pom.xml backend-comments/pom.xml
COPY backend-redactions/pom.xml backend-redactions/pom.xml
COPY backend-export/pom.xml backend-export/pom.xml
COPY backend-session-cycles/pom.xml backend-session-cycles/pom.xml
COPY backend-profiles/pom.xml backend-profiles/pom.xml
COPY backend-settings/pom.xml backend-settings/pom.xml
COPY backend-interception/pom.xml backend-interception/pom.xml
COPY backend-scenarios/pom.xml backend-scenarios/pom.xml
COPY backend-relive/pom.xml backend-relive/pom.xml
COPY backend-logs/pom.xml backend-logs/pom.xml
COPY backend-resend/pom.xml backend-resend/pom.xml
COPY backend-db-capture/pom.xml backend-db-capture/pom.xml
COPY backend-triage/pom.xml backend-triage/pom.xml
COPY backend-app/pom.xml backend-app/pom.xml
COPY backend-architecture-test/pom.xml backend-architecture-test/pom.xml
RUN mvn -B dependency:go-offline

COPY . .
# Tests run in CI/host verification; the runtime image only needs production classes.
RUN mvn -B package -Dmaven.test.skip=true

FROM eclipse-temurin:21-jre

WORKDIR /app

COPY --from=build /app/backend-app/target/backend.jar app.jar

EXPOSE 5000

# Without an explicit cap, the JVM sizes its default heap as a percentage of whatever memory it can
# see - the whole host, unless the container itself has a memory limit (set in docker-compose.yml) -
# and a JVM heap that's grown under load generally isn't returned to the OS afterward, which reads
# as "this container uses a lot of memory" even with nothing actually leaking. Capping it relative to
# the container's own limit keeps that bounded and predictable regardless of the host's size.
#
# G1 stays the collector (short pauses are not the problem here; CPU bursts were). Without a CPU limit
# the JVM sizes its GC thread pools to every core of the host (13 parallel GC threads on a 16-core
# machine), so each collection briefly lit up most of the CPU; 4 + 2 threads are plenty for a 1 GB heap.
# ExitOnOutOfMemoryError: after an OutOfMemoryError a JVM keeps running but half-broken (threads died
# mid-work, every request fails); exiting lets Docker's restart policy bring up a clean backend instead.
CMD ["java", "-XX:MaxRAMPercentage=50", "-XX:InitialRAMPercentage=25", "-XX:+UseG1GC", "-XX:ParallelGCThreads=4", "-XX:ConcGCThreads=2", "-XX:+ExitOnOutOfMemoryError", "-jar", "app.jar"]
