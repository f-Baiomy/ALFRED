package com.fathy.alfred.backend.board.domain;

import com.fathy.alfred.backend.board.domain.model.Team;

import java.util.List;

/**
 * The teams a new board starts with - added once, the first time board.db is opened, and the user's to edit or delete
 * after that. The "owns" text is what Claude reads to pick a team, so it names the evidence that points at each one.
 */
public final class DefaultTeams {

    public static final List<Team> ALL = List.of(
            new Team("frontend", "Frontend", "#5b8def", "▣",
                    "The web UI (Angular / TypeScript / HTML / CSS): what the page shows, what it validates, and the request the browser"
                            + " sends - a wrong body, parameter or header, a blank or wrong screen, an error the page does not show.",
                    List.of(".ts:", ".html", ".scss", "frontend/", "angular"), 0),
            new Team("backend", "Backend", "#7ee3a0", "⚙",
                    "The Java services: controllers, business rules, error handling, 5xx responses, exceptions and stack traces,"
                            + " missing or wrong log lines.",
                    List.of(".java:", "exception", "controller"), 1),
            new Team("database", "Database", "#2dd4bf", "◆",
                    "SQL and the schema: failed or rolled-back statements, N+1 and repeated queries, slow queries, missing indexes,"
                            + " transactions, data that is saved wrong.",
                    List.of("@[stmt:", "n+1", "deadlock", "constraint"), 2),
            new Team("integrations", "Integrations", "#e3a24a", "⇄",
                    "Calls to suppliers and other outside systems (outbound): Galileo, Sabre, Amadeus, NDC and the like - their"
                            + " errors, timeouts, mapping of their requests and responses, supplier errors swallowed behind a 200.",
                    List.of("@[call:out", "supplier", "galileo", "sabre", "amadeus", "ndc"), 3),
            new Team("devops", "DevOps", "#e37ec4", "☁",
                    "Deployment and infrastructure: configuration, environment variables, certificates, ports, Redis and other"
                            + " infrastructure, container restarts, a build that is not deployed.",
                    List.of("deploy", "docker", "certificate", "redis", "@[redis"), 4),
            new Team("qa", "QA", "#c9c9d0", "✓",
                    "Testing itself: test data, the spec and its acceptance items, steps or flows that were not exercised, checks"
                            + " that could not be made.",
                    List.of("@[spec:", "acceptance", "test data"), 5));

    private DefaultTeams() {
    }
}
