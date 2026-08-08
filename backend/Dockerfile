FROM maven:3.9-eclipse-temurin-21 AS build

WORKDIR /app

# Copy every module's pom.xml first (not the sources yet) so `dependency:go-offline`
# gets its own Docker layer - it only re-runs when a pom.xml actually changes, not on
# every source edit.
COPY pom.xml .
COPY pennyworth-platform/pom.xml pennyworth-platform/pom.xml
COPY pennyworth-calls/pom.xml pennyworth-calls/pom.xml
COPY pennyworth-comments/pom.xml pennyworth-comments/pom.xml
COPY pennyworth-export/pom.xml pennyworth-export/pom.xml
COPY pennyworth-session-cycles/pom.xml pennyworth-session-cycles/pom.xml
COPY pennyworth-app/pom.xml pennyworth-app/pom.xml
COPY pennyworth-architecture-test/pom.xml pennyworth-architecture-test/pom.xml
RUN mvn -B dependency:go-offline

COPY . .
RUN mvn -B package -DskipTests

FROM eclipse-temurin:21-jre

WORKDIR /app

COPY --from=build /app/pennyworth-app/target/pennyworth.jar app.jar

EXPOSE 5000

CMD ["java", "-jar", "app.jar"]
