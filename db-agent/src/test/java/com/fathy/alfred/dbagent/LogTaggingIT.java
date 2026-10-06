package com.fathy.alfred.dbagent;

import org.apache.log4j.MDC;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static com.fathy.alfred.dbagent.AgentTestSupport.SINK;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * The log-linking switch (specs/008-logs-call-link, contracts/agent-log-tagging.md): with log=1 in X-Alfred-Call the
 * request's log lines carry its call id under {@code alfred.call} in the application's MDC - captured (db=1) or not -
 * the value that was there before comes back afterwards, and work handed to a pool thread carries it too.
 */
class LogTaggingIT {

    private static final String KEY = "alfred.call";

    @BeforeEach
    void reset() {
        AgentTestSupport.reset();
        MDC.remove(KEY);
    }

    @Test
    void taggedWithLogOneWhetherCapturedOrNot() throws Exception {
        List<Object> seen = Collections.synchronizedList(new ArrayList<>());
        AgentTestSupport.inCall("id=call-a; db=0; log=1", () -> seen.add(MDC.get(KEY)));
        AgentTestSupport.inCall("id=call-b; db=1; log=1", () -> seen.add(MDC.get(KEY)));

        assertThat(seen).containsExactly("call-a", "call-b");
        assertThat(MDC.get(KEY)).isNull();
        // db=0; log=1 is a logs-only call (specs/009): a CALL_OPEN that says so, and no statements
        assertThat(SINK.markers()).filteredOn(m -> "call-a".equals(m.callId)).extracting(m -> m.logs).containsExactly(true);
        assertThat(SINK.statementsOf("call-a")).isEmpty();
    }

    @Test
    void untouchedWithoutLogOne() throws Exception {
        List<Object> seen = Collections.synchronizedList(new ArrayList<>());
        AgentTestSupport.inCall("id=call-c; db=1", () -> seen.add(MDC.get(KEY)));
        AgentTestSupport.inCall("id=call-d; db=0; log=0", () -> seen.add(MDC.get(KEY)));

        assertThat(seen).containsExactly(null, null);
    }

    @Test
    void thePreviousValueComesBack() throws Exception {
        MDC.put(KEY, "outer");
        Object[] inside = {null};
        AgentTestSupport.inCall("id=call-e; db=0; log=1", () -> inside[0] = MDC.get(KEY));

        assertThat(inside[0]).isEqualTo("call-e");
        assertThat(MDC.get(KEY)).isEqualTo("outer");
    }

    @Test
    void workHandedToAPoolThreadIsTaggedAndThePoolThreadIsCleanAfter() throws Exception {
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            pool.submit(() -> MDC.put("warm", "1")).get(); // the pool thread exists before the call
            Object[] inTask = {null};
            AgentTestSupport.inCall("id=call-f; db=0; log=1", () -> pool.submit(() -> inTask[0] = MDC.get(KEY)).get(5, TimeUnit.SECONDS));
            Object after = pool.submit(() -> MDC.get(KEY)).get();

            assertThat(inTask[0]).isEqualTo("call-f");
            assertThat(after).isNull();
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void taggingCostsWellUnderAMillisecondPerRequest() throws Exception {
        int requests = 2_000;
        for (int i = 0; i < 200; i++) {
            AgentTestSupport.inCall("id=warm-" + i + "; db=0; log=1", () -> { });
        }
        long off = System.nanoTime();
        for (int i = 0; i < requests; i++) {
            AgentTestSupport.inCall("id=off-" + i + "; db=0; log=0", () -> { });
        }
        off = System.nanoTime() - off;
        long on = System.nanoTime();
        for (int i = 0; i < requests; i++) {
            AgentTestSupport.inCall("id=on-" + i + "; db=0; log=1", () -> { });
        }
        on = System.nanoTime() - on;
        double addedMicros = (on - off) / 1000.0 / requests;
        System.out.printf("[LogTaggingIT] log tagging adds %.1f us per request%n", addedMicros);
        assertThat(addedMicros).isLessThan(1000.0);
    }
}
