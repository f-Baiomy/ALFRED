package com.fathy.alfred.dbagent;

import com.fathy.alfred.dbagent.transport.LogRecord;
import com.fathy.alfred.dbagent.transport.MarkerRecord;
import org.jboss.logmanager.ExtLogRecord;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.logging.Level;
import java.util.stream.Collectors;

import static com.fathy.alfred.dbagent.AgentTestSupport.SETTINGS;
import static com.fathy.alfred.dbagent.AgentTestSupport.SINK;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * The agent catching the application's log lines (specs/009-agent-log-capture): every framework, once, after the
 * application's own level check, on the right call, in the call's order - and nothing for a call without log=1.
 */
class LogCaptureIT {

    @BeforeEach
    void reset() {
        AgentTestSupport.reset();
    }

    private static List<LogRecord> of(String callId) {
        return SINK.logs().stream().filter(l -> callId.equals(l.callId)).collect(Collectors.toList());
    }

    @Test
    void julLogbackLog4j2AndLogmanagerAreCaughtOnceWithTheirFields() throws Exception {
        AgentTestSupport.inCall("id=c-all; db=0; log=1", () -> {
            java.util.logging.Logger.getLogger("jul.app").log(Level.WARNING, "jul {0}", "one");
            java.util.logging.Logger.getLogger("jul.app").fine("below JUL's INFO default");
            org.slf4j.LoggerFactory.getLogger("logback.app").info("logback {}", 2);
            org.slf4j.LoggerFactory.getLogger("logback.app").debug("below logback-test.xml's INFO");
            org.apache.logging.log4j.LogManager.getLogger("log4j2.app").error("log4j2 boom", new IllegalStateException("bad state"));
            org.apache.logging.log4j.LogManager.getLogger("log4j2.app").info("below log4j 2's default ERROR");
            // WildFly's core; its logRaw also hands the record to a JUL logger (a bridge): still one line
            new org.jboss.logmanager.Logger().logRaw(new ExtLogRecord(Level.INFO, "logmanager three", "jboss.app"));
        });

        List<LogRecord> lines = of("c-all");
        assertThat(lines).extracting(l -> l.message).containsExactly("jul one", "logback 2", "log4j2 boom", "logmanager three");
        assertThat(lines).extracting(l -> l.logger).containsExactly("jul.app", "logback.app", "log4j2.app", "jboss.app");
        assertThat(lines).extracting(l -> l.level).containsExactly("WARNING", "INFO", "ERROR", "INFO");
        LogRecord boom = lines.get(2);
        assertThat(boom.exceptionType).isEqualTo(IllegalStateException.class.getName());
        assertThat(boom.exceptionMessage).isEqualTo("bad state");
        assertThat(boom.exceptionStack).contains("LogCaptureIT");
        assertThat(lines).allMatch(l -> l.thread != null && l.at.matches("\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z"));
        // a logs-only call records no statements but says it catches its lines
        assertThat(SINK.markers()).filteredOn(m -> "c-all".equals(m.callId) && "CALL_OPEN".equals(m.type))
                .extracting(m -> m.logs).containsExactly(true);
    }

    @Test
    void theProjectsLogLevelKeepsOnlyLinesAtOrAboveIt() throws Exception {
        SETTINGS.applyLogLevel(null); // what an agent has before its first heartbeat: ERROR
        Runnable everyFramework = () -> {
            java.util.logging.Logger.getLogger("jul.app").warning("jul warn");
            java.util.logging.Logger.getLogger("jul.app").severe("jul severe");
            org.slf4j.LoggerFactory.getLogger("logback.app").info("logback info");
            org.slf4j.LoggerFactory.getLogger("logback.app").warn("logback warn");
            org.slf4j.LoggerFactory.getLogger("logback.app").error("logback error");
            org.apache.logging.log4j.LogManager.getLogger("log4j2.app").error("log4j2 error");
            new org.jboss.logmanager.Logger().logRaw(new ExtLogRecord(Level.INFO, "logmanager info", "jboss.app"));
            new org.jboss.logmanager.Logger().logRaw(new ExtLogRecord(Level.SEVERE, "logmanager error", "jboss.app"));
        };
        AgentTestSupport.inCall("id=c-err; db=0; log=1", everyFramework::run);
        SETTINGS.applyLogLevel("WARN");
        AgentTestSupport.inCall("id=c-warn; db=0; log=1", everyFramework::run);
        SETTINGS.applyLogLevel("APP");
        AgentTestSupport.inCall("id=c-app; db=0; log=1", everyFramework::run);

        assertThat(of("c-err")).extracting(l -> l.message).containsExactly("jul severe", "logback error", "log4j2 error", "logmanager error");
        assertThat(of("c-warn")).extracting(l -> l.message)
                .containsExactly("jul warn", "jul severe", "logback warn", "logback error", "log4j2 error", "logmanager error");
        assertThat(of("c-app")).hasSize(8);
        // a line below the level counts toward no cap: nothing dropped, the kept lines number from the call's start
        assertThat(SINK.droppedLogsOf("c-err")).isZero();
    }

    @Test
    void nothingIsCaughtWithoutLogOneOrOutsideAnyCallWhenNotAsked() throws Exception {
        AgentTestSupport.inCall("id=c-db; db=1", () -> java.util.logging.Logger.getLogger("x").warning("not linked"));
        java.util.logging.Logger.getLogger("x").warning("outside, not asked");

        assertThat(SINK.logs()).isEmpty();
    }

    @Test
    void outsideCallLinesAreCaughtWhenTheProjectAsks() {
        SETTINGS.applyLogs(true);
        java.util.logging.Logger.getLogger("job").warning("scheduler fired");

        assertThat(SINK.logs()).filteredOn(l -> "scheduler fired".equals(l.message)).singleElement()
                .satisfies(l -> {
                    assertThat(l.callId).isNull();
                    assertThat(l.seq).isZero();
                });
    }

    @Test
    void aLineTakesItsPlaceAmongTheCallsStatements() throws Exception {
        AgentTestSupport.inCall("id=c-seq; db=1; log=1", () -> {
            try (Connection c = DriverManager.getConnection("jdbc:h2:mem:logseq"); Statement s = c.createStatement()) {
                s.execute("CREATE TABLE IF NOT EXISTS t (x INT)");
                java.util.logging.Logger.getLogger("x").warning("between");
                s.execute("INSERT INTO t VALUES (1)");
            }
        });

        int line = of("c-seq").get(0).seq;
        List<Integer> statements = SINK.statementsOf("c-seq").stream().map(s -> s.seq).collect(Collectors.toList());
        assertThat(statements).anyMatch(seq -> seq < line).anyMatch(seq -> seq > line);
    }

    @Test
    void workHandedToAPoolThreadLogsIntoItsCall() throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            AgentTestSupport.inCall("id=c-pool; db=0; log=1", () ->
                    pool.submit(() -> java.util.logging.Logger.getLogger("x").warning("from the pool")).get(5, TimeUnit.SECONDS));
        } finally {
            pool.shutdownNow();
        }
        assertThat(of("c-pool")).extracting(l -> l.message).containsExactly("from the pool");
    }

    @Test
    void aCallKeepsAtMostFiveThousandLinesAndCountsTheRest() throws Exception {
        AgentTestSupport.inCall("id=c-cap; db=0; log=1", () -> {
            java.util.logging.Logger log = java.util.logging.Logger.getLogger("x");
            for (int i = 0; i < 5_010; i++) {
                log.warning("line " + i);
            }
            log.warning(new String(new char[40_000]).replace('\0', 'y'));
        });

        assertThat(of("c-cap")).hasSize(5_000);
        assertThat(SINK.droppedLogsOf("c-cap")).isEqualTo(11);
    }

    @Test
    void aHugeLineIsCutAndMarked() throws Exception {
        AgentTestSupport.inCall("id=c-big; db=0; log=1", () ->
                java.util.logging.Logger.getLogger("x").warning(new String(new char[40_000]).replace('\0', 'y')));

        LogRecord big = of("c-big").get(0);
        assertThat(big.cut).isTrue();
        assertThat(big.message).hasSize(16_000);
    }

    @Test
    void oneHundredConcurrentCallsEachGetOnlyTheirOwnLines() throws Exception {
        // slf4j queues lines other threads log while it is still initialising and replays them later on the
        // initialising thread - a start-up artefact, not attribution: initialise it first, as a running server has
        org.slf4j.LoggerFactory.getLogger("conc").debug("warm up");
        ExecutorService requests = Executors.newFixedThreadPool(16);
        try {
            List<Future<?>> done = new ArrayList<>();
            for (int i = 0; i < 100; i++) {
                String id = "cc-" + i;
                done.add(requests.submit(() -> {
                    AgentTestSupport.inCall("id=" + id + "; db=0; log=1", () -> {
                        for (int k = 0; k < 5; k++) {
                            org.slf4j.LoggerFactory.getLogger("conc").info("{} line {}", id, k);
                        }
                    });
                    return null;
                }));
            }
            for (Future<?> f : done) {
                f.get(30, TimeUnit.SECONDS);
            }
        } finally {
            requests.shutdownNow();
        }
        List<LogRecord> all = SINK.logs().stream().filter(l -> l.callId != null && l.callId.startsWith("cc-")).collect(Collectors.toList());
        assertThat(all).hasSize(500);
        assertThat(all.stream().filter(l -> !l.message.startsWith(l.callId + " line ")).map(l -> l.callId + " <- " + l.message))
                .isEmpty();
        assertThat(SINK.markers()).filteredOn(m -> m.callId != null && m.callId.startsWith("cc-")).extracting((MarkerRecord m) -> m.logs)
                .containsOnly(true);
    }
}
