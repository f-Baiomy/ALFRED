package com.fathy.alfred.backend.sessioncycles.application.service;

import com.fathy.alfred.backend.sessioncycles.application.service.LegacySpacerAnchors.AfterAnchor;
import com.fathy.alfred.backend.sessioncycles.application.service.LegacySpacerAnchors.TimelineCall;
import com.fathy.alfred.backend.sessioncycles.domain.model.LegacyCycleSpacer;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class LegacySpacerAnchorsTest {

    // Deliberately out of order and in both timestamp shapes the capture paths produce - the
    // conversion has to order by time, not by list position or string.
    private static final List<TimelineCall> CALLS = List.of(
            new TimelineCall("get-check", "GET", "2026-09-23T11:38:47.011853+00:00"),
            new TimelineCall("get-branches", "GET", "2026-09-23T11:38:30Z"),
            new TimelineCall("options-check", "OPTIONS", "2026-09-23T11:38:46.900+00:00"),
            new TimelineCall("options-upselling", "OPTIONS", "2026-09-23T11:38:46.950+00:00"));

    private static AfterAnchor convert(String beforeCallId, String anchorTimestamp) {
        return LegacySpacerAnchors.convert(new LegacyCycleSpacer("s1", beforeCallId, anchorTimestamp), CALLS);
    }

    @Test
    void anchoredBeforeACallBecomesAfterTheNearestEarlierNonOptionsCall() {
        // The live case: added at the end after /lookup/branches, pinned past two hidden preflights
        // to GET CHECK - it belongs after /lookup/branches.
        assertThat(convert("get-check", "2026-09-23T11:38:47.011853+00:00"))
                .isEqualTo(new AfterAnchor("get-branches", "2026-09-23T11:38:30Z"));
    }

    @Test
    void trailingBecomesAfterTheLastNonOptionsCall() {
        assertThat(convert(null, null)).isEqualTo(new AfterAnchor("get-check", "2026-09-23T11:38:47.011853+00:00"));
    }

    @Test
    void anOrphanUsesItsTimestampToFindTheCallBeforeIt() {
        assertThat(convert(null, "2026-09-23T11:38:47Z")).isEqualTo(new AfterAnchor("get-branches", "2026-09-23T11:38:30Z"));
    }

    @Test
    void anAnchorThatNoLongerExistsFallsBackToItsTimestamp() {
        assertThat(convert("gone", "2026-09-23T11:38:47Z")).isEqualTo(new AfterAnchor("get-branches", "2026-09-23T11:38:30Z"));
    }

    @Test
    void nothingEarlierToAttachToMeansAboveEveryCall() {
        assertThat(convert("get-branches", "2026-09-23T11:38:30Z")).isEqualTo(new AfterAnchor(null, null));
    }

    @Test
    void anEmptyCycleConvertsToAboveEveryCall() {
        assertThat(LegacySpacerAnchors.convert(new LegacyCycleSpacer("s1", null, null), List.of())).isEqualTo(new AfterAnchor(null, null));
    }
}
