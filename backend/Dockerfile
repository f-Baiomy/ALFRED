FROM maven:3.9-eclipse-temurin-21 AS build

WORKDIR /app

# Copy every module's pom.xml first (not the sources yet) so `dependency:go-offline`
# gets its own Docker layer - it only re-runs when a pom.xml actually changes, not on
# every source edit.
COPY pom.xml .
COPY backend-platform/pom.xml backend-platform/pom.xml
COPY backend-calls/pom.xml backend-calls/pom.xml
COPY backend-comments/pom.xml backend-comments/pom.xml
COPY backend-export/pom.xml backend-export/pom.xml
COPY backend-session-cycles/pom.xml backend-session-cycles/pom.xml
COPY backend-profiles/pom.xml backend-profiles/pom.xml
COPY backend-app/pom.xml backend-app/pom.xml
COPY backend-architecture-test/pom.xml backend-architecture-test/pom.xml
RUN mvn -B dependency:go-offline

COPY . .
RUN mvn -B package -DskipTests

FROM eclipse-temurin:21-jre

WORKDIR /app

COPY --from=build /app/backend-app/target/backend.jar app.jar

EXPOSE 5000

CMD ["java", "-jar", "app.jar"]
