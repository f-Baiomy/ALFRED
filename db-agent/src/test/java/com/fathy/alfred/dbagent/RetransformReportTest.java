package com.fathy.alfred.dbagent;

import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Attaching to a running app retransforms the classes it already loaded; the one line the agent prints says how many
 * got their advice and which the JVM refused - before, a refused batch silently left every JDBC class uninstrumented.
 */
class RetransformReportTest {

    @Test
    void everyClassInstrumentedSaysSo() {
        assertThat(Instrumenter.RetransformReport.summary(120, Collections.emptyMap()))
                .isEqualTo("instrumented 120 of 120 already-loaded classes");
    }

    @Test
    void theClassesTheJvmRefusedAreNamed() {
        Map<List<Class<?>>, Throwable> failures = new LinkedHashMap<>();
        // a refused batch is split and retried down to the class that fails alone; the batches it was in are recorded
        // too, and a class that failed in two passes is one class
        failures.put(Arrays.asList(String.class, Integer.class, Long.class, Short.class), new InternalError());
        failures.put(Arrays.asList(String.class, Integer.class), new InternalError());
        failures.put(Collections.singletonList(String.class), new UnsupportedOperationException());
        failures.put(Arrays.asList(Long.class, Short.class), new InternalError());
        failures.put(Collections.singletonList(Long.class), new InternalError());
        failures.put(Collections.singletonList(String.class), new UnsupportedOperationException());
        assertThat(Instrumenter.RetransformReport.summary(120, failures))
                .isEqualTo("instrumented 118 of 120 already-loaded classes - not instrumented, so not captured: "
                        + "java.lang.String (UnsupportedOperationException), java.lang.Long (InternalError)");
    }

    @Test
    void theBatchesAreSmallSoOneRefusedClassCannotTakeTheRestWithIt() {
        assertThat(Instrumenter.RETRANSFORM_BATCH).isBetween(1, 100);
    }
}
