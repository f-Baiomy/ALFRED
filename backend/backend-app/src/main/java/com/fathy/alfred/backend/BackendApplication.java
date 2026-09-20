package com.fathy.alfred.backend;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * Excludes Spring Boot's own DataSource autoconfiguration: every slice's SQLite repository
 * builds and owns its own HikariDataSource manually (one per storage file - calls.db,
 * session-cycles.db, profiles.db, comments.db, settings.db - not one shared connection pool),
 * so there's no single {@code spring.datasource.url} for Spring Boot to configure. Without this
 * exclusion, having spring-boot-starter-jdbc on the classpath (for JdbcTemplate) makes Spring
 * Boot try to auto-configure a default DataSource and fail startup since none is configured.
 */
@SpringBootApplication(exclude = DataSourceAutoConfiguration.class)
// backend-interception's BreakpointService needs a timer: a call held at the proxy waiting for a
// human has to be dropped from the queue once its deadline passes, or the inspector keeps
// offering a decision about a caller that gave up. Nothing else in Alfred is scheduled - there is
// deliberately no polling anywhere (see docs/frontend-architecture.md), and this is not polling:
// it is an expiry sweep over an in-memory registry that is empty in the normal case.
@EnableScheduling
public class BackendApplication {

    public static void main(String[] args) {
        SpringApplication.run(BackendApplication.class, args);
    }
}
