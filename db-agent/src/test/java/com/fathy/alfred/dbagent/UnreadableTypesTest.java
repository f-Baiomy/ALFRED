package com.fathy.alfred.dbagent;

import net.bytebuddy.pool.TypePool;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Drools compiles each rule's consequence into a class held only in memory; matching it fails with
 * NoSuchTypeException. That used to print one "could not instrument" WARN per class - hundreds for a rule base.
 */
class UnreadableTypesTest {

    @Test
    void aTypePoolResolutionFailureIsRecognisedAlsoWhenWrapped() {
        TypePool.Resolution.NoSuchTypeException missing = new TypePool.Resolution.NoSuchTypeException("com.travel.Rule_x");
        assertThat(Instrumenter.UnreadableTypes.is(missing)).isTrue();
        assertThat(Instrumenter.UnreadableTypes.is(new IllegalStateException("matching", missing))).isTrue();
        assertThat(Instrumenter.UnreadableTypes.is(new UnsupportedOperationException())).isFalse();
    }

    @Test
    void oneSummaryLineAMinuteCountingTheClassesInBetween() {
        Instrumenter.UnreadableTypes types = new Instrumenter.UnreadableTypes();
        assertThat(types.add("Rule_a", 1_000)).isEqualTo("left 1 class uninstrumented whose supertypes cannot be read"
                + " (generated in memory, e.g. Rule_a) - they run unchanged");
        assertThat(types.add("Rule_b", 2_000)).isNull();
        assertThat(types.add("Rule_c", 3_000)).isNull();
        assertThat(types.add("Rule_d", 1_000 + Instrumenter.UnreadableTypes.QUIET_MILLIS)).isEqualTo("left 3 classes uninstrumented"
                + " whose supertypes cannot be read (generated in memory, e.g. Rule_d) - they run unchanged");
    }
}
