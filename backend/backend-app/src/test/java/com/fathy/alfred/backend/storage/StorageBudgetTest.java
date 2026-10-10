package com.fathy.alfred.backend.storage;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** The budget is one number; every share is a ratio of it. */
class StorageBudgetTest {

    private static final long GB = StorageBudget.GB;

    private static StorageBudget budget(long gb, String split) {
        return new StorageBudget(gb * GB, split, Map.of(), 0, 0, 10, Map.of()).validated();
    }

    @Test
    void theRecommendedSplitGivesEachShareItsRatio() {
        Map<String, Long> shares = budget(20, "recommended").shareBytes();

        assertThat(shares.get("inbound")).isEqualTo((long) Math.floor(20 * GB * 0.55));
        assertThat(shares.get("capture")).isEqualTo((long) Math.floor(20 * GB * 0.20));
        assertThat(shares.get("outbound")).isEqualTo((long) Math.floor(20 * GB * 0.10));
        assertThat(shares.values().stream().mapToLong(Long::longValue).sum()).isLessThanOrEqualTo(20 * GB);
    }

    @Test
    void raisingTheBudgetRaisesEveryShareByTheSameFactor() {
        Map<String, Long> ten = budget(10, "recommended").shareBytes();
        Map<String, Long> thirty = budget(30, "recommended").shareBytes();

        for (String share : StorageBudget.SHARES) {
            assertThat((double) thirty.get(share) / ten.get(share)).isCloseTo(3.0, org.assertj.core.data.Offset.offset(0.0001));
        }
    }

    @Test
    void customRatiosAreScaledToTheWholeBudget() {
        StorageBudget custom = new StorageBudget(10 * GB, "custom",
                Map.of("inbound", 2.0, "capture", 1.0, "outbound", 1.0, "logs", 0.0, "reliveRuns", 0.0, "work", 0.0),
                0, 0, 0, Map.of()).validated();

        assertThat(custom.shareBytes().get("inbound")).isEqualTo(5 * GB);
        assertThat(custom.shareBytes().get("capture")).isEqualTo((long) (2.5 * GB));
    }

    @Test
    void noBudgetMeansNoShares() {
        assertThat(StorageBudget.NONE.isSet()).isFalse();
        assertThat(StorageBudget.NONE.shareBytes().values()).containsOnly(0L);
    }

    @Test
    void refusesWhatCannotBeApplied() {
        assertThatThrownBy(() -> new StorageBudget(GB / 2, "recommended", Map.of(), 0, 0, 0, Map.of()).validated())
                .hasMessageContaining("at least 1 GB");
        assertThatThrownBy(() -> new StorageBudget(5 * GB, "weird", Map.of(), 0, 0, 0, Map.of()).validated())
                .hasMessageContaining("Unknown split");
        assertThatThrownBy(() -> new StorageBudget(5 * GB, "recommended", Map.of(), -1, 0, 0, Map.of()).validated())
                .hasMessageContaining("negative");
        assertThatThrownBy(() -> new StorageBudget(5 * GB, "recommended", Map.of(), 0, 0, 0, Map.of("logs", 3)).validated())
                .hasMessageContaining("No age rule");
    }
}
