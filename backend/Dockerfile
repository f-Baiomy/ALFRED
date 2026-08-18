FROM maven:3.9-eclipse-temurin-21 AS build

WORKDIR /app

# Copy every module's pom.xml first (not the sources yet) so `dependency:go-offline`
# gets its own Docker layer - it only re-runs when a pom.xml actually changes, not on
# every source edit.
COPY pom.xml .
COPY backend-platform/pom.xml backend-platform/pom.xml
COPY backend-calls/pom.xml backend-calls/pom.xml
COPY backend-internal-calls/pom.xml backend-internal-calls/pom.xml
COPY backend-comments/pom.xml backend-comments/pom.xml
COPY backend-export/pom.xml backend-export/pom.xml
COPY backend-session-cycles/pom.xml backend-session-cycles/pom.xml
COPY backend-profiles/pom.xml backend-profiles/pom.xml
COPY backend-settings/pom.xml backend-settings/pom.xml
COPY backend-app/pom.xml backend-app/pom.xml
COPY backend-architecture-test/pom.xml backend-architecture-test/pom.xml
RUN mvn -B dependency:go-offline

COPY . .
RUN mvn -B package -DskipTests

FROM eclipse-temurin:21-jre

WORKDIR /app

COPY --from=build /app/backend-app/target/backend.jar app.jar

EXPOSE 5000

# Without an explicit cap, the JVM sizes its default heap as a percentage of whatever memory it can
# see - the whole host, unless the container itself has a memory limit (set in docker-compose.yml) -
# and a JVM heap that's grown under load generally isn't returned to the OS afterward, which reads
# as "this container uses a lot of memory" even with nothing actually leaking. Capping it relative to
# the container's own limit keeps that bounded and predictable regardless of the host's size.
CMD ["java", "-XX:MaxRAMPercentage=50", "-XX:InitialRAMPercentage=25", "-jar", "app.jar"]
