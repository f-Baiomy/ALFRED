package com.fathy.alfred.backend.sessioncycles.application.service;

import com.fathy.alfred.backend.sessioncycles.domain.model.LegacyCycleSpacer;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.Comparator;
import java.util.List;

/**
 * Converts a spacer from the original "sits before this call" form to the current "sits after this
 * call" one (see CycleSpacer). The original form anchored to the call BELOW the gap - and a spacer
 * added at the end of a recording cycle was pinned to whatever call was captured next, OPTIONS
 * preflights skipped. Since OPTIONS calls are hidden by default, the call the user actually saw
 * above the gap is the nearest earlier call that ISN'T a preflight - so that's what it converts to:
 *
 * <ul>
 *   <li>anchored before call X - the nearest non-OPTIONS call before X;</li>
 *   <li>anchor call gone but a timestamp T left - the nearest non-OPTIONS call before T;</li>
 *   <li>trailing (both null), or anchored to a call that no longer exists - the last non-OPTIONS call;</li>
 *   <li>nothing earlier to attach to - above every call (both null).</li>
 * </ul>
 *
 * Works over outbound and inbound calls together, by time, since a cycle's list interleaves both.
 */
final class LegacySpacerAnchors {

    /** One captured call of either kind, reduced to what ordering and anchoring need. */
    record TimelineCall(String id, String method, String timestamp) {
    }

    /** The converted anchor - both null means "above every call". */
    record AfterAnchor(String afterCallId, String anchorTimestamp) {
    }

    private LegacySpacerAnchors() {
    }

    static AfterAnchor convert(LegacyCycleSpacer legacy, List<TimelineCall> calls) {
        List<TimelineCall> timeline = calls.stream()
                .sorted(Comparator.comparing((TimelineCall c) -> instantOf(c.timestamp()), Comparator.nullsFirst(Comparator.naturalOrder())))
                .toList();

        int end = timeline.size();
        int anchorIndex = legacy.beforeCallId() == null ? -1 : indexOf(timeline, legacy.beforeCallId());
        if (anchorIndex >= 0) {
            end = anchorIndex;
        } else if (legacy.anchorTimestamp() != null) {
            Instant t = instantOf(legacy.anchorTimestamp());
            if (t != null) {
                end = 0;
                while (end < timeline.size() && isBefore(timeline.get(end), t)) end++;
            }
        }

        for (int i = end - 1; i >= 0; i--) {
            TimelineCall call = timeline.get(i);
            if (!"OPTIONS".equalsIgnoreCase(call.method())) {
                return new AfterAnchor(call.id(), call.timestamp());
            }
        }
        return new AfterAnchor(null, null);
    }

    private static int indexOf(List<TimelineCall> timeline, String id) {
        for (int i = 0; i < timeline.size(); i++) {
            if (timeline.get(i).id().equals(id)) return i;
        }
        return -1;
    }

    private static boolean isBefore(TimelineCall call, Instant t) {
        Instant at = instantOf(call.timestamp());
        return at == null || at.isBefore(t);
    }

    /** Captured timestamps come both as "...Z" and "...+00:00" (with varying fraction lengths) - OffsetDateTime reads either. */
    static Instant instantOf(String timestamp) {
        if (timestamp == null) return null;
        try {
            return OffsetDateTime.parse(timestamp).toInstant();
        } catch (DateTimeParseException e) {
            return null;
        }
    }
}
