package com.fathy.alfred.backend.triage.domain;

import com.fathy.alfred.backend.triage.domain.model.CallAttention;

import java.util.Collection;

/**
 * Triage's reading order (specs/007-alfred-mcp-server/triage-plan.md, section 1). A call "needs attention" when its
 * status is at or over the threshold (300 by default, so redirects count), it has an error, or it is still running long
 * after it should have finished. Then:
 *
 * <ol>
 *   <li>needs attention, and a supplier call of it needs attention too (or has an error inside a 2xx body)</li>
 *   <li>needs attention, with failed database statements</li>
 *   <li>needs attention, nothing under it failed</li>
 *   <li>succeeded, but a supplier call or a database statement under it failed - a hidden failure</li>
 *   <li>succeeded, with an error inside its own body or an empty result</li>
 *   <li>everything else</li>
 * </ol>
 * The groups order the work; they exclude nothing.
 */
public final class Priority {

    /** The threshold the stored priority is computed for. Reads may ask for a higher one, never a lower one. */
    public static final int STORED_MIN_STATUS = 300;
    public static final int MAX_MIN_STATUS = 600;
    /** A call still IN_PROGRESS this long after it started is treated as failing (a hung request). */
    public static final long STALE_IN_PROGRESS_MS = 5 * 60_000L;

    private Priority() {
    }

    public static boolean needsAttention(CallAttention call, int minStatus, long now) {
        if (call.error() != null && !call.error().isBlank()) {
            return true;
        }
        if (call.status() != null && call.status() >= minStatus) {
            return true;
        }
        return CallAttention.IN_PROGRESS.equals(call.state()) && call.startedAt() > 0 && now - call.startedAt() > STALE_IN_PROGRESS_MS;
    }

    /** A supplier call counts against its parent when it needs attention or hides an error inside a 2xx body. */
    public static boolean failingSupplierCall(CallAttention child, int minStatus, long now) {
        return needsAttention(child, minStatus, now) || child.softFailure() != null;
    }

    public static int countFailing(Collection<CallAttention> children, int minStatus, long now) {
        return (int) children.stream().filter(c -> failingSupplierCall(c, minStatus, now)).count();
    }

    public static int of(CallAttention call, int failingChildren, int minStatus, long now) {
        boolean needs = needsAttention(call, minStatus, now);
        boolean statementsFailed = call.failedStatements() > 0;
        if (needs) {
            if (failingChildren > 0) {
                return 1;
            }
            return statementsFailed ? 2 : 3;
        }
        if (failingChildren > 0 || statementsFailed) {
            return 4;
        }
        if (call.softFailure() != null || !call.emptyKeys().isEmpty()) {
            return 5;
        }
        return 6;
    }

    /** Clamps a requested threshold into what the stored priority can answer (300..600). */
    public static int clampMinStatus(Integer requested) {
        if (requested == null) {
            return STORED_MIN_STATUS;
        }
        return Math.max(STORED_MIN_STATUS, Math.min(MAX_MIN_STATUS, requested));
    }
}
