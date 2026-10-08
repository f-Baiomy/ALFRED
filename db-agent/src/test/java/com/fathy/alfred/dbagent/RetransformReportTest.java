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
        failures.put(Collections.singletonList(String.class), new UnsupportedOperationException());
        failures.put(Arrays.asList(Integer.class, Long.class), new InternalError());
        assertThat(Instrumenter.RetransformReport.summary(120, failures))
                .isEqualTo("instrumented 117 of 120 already-loaded classes - not instrumented, so not captured: "
                        + "java.lang.String (UnsupportedOperationException), java.lang.Integer (InternalError), java.lang.Long (InternalError)");
    }

    @Test
    void theBatchesAreSmallSoOneRefusedClassCannotTakeTheRestWithIt() {
        assertThat(Instrumenter.RETRANSFORM_BATCH).isBetween(1, 100);
    }
}
