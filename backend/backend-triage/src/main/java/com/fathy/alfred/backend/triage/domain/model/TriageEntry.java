package com.fathy.alfred.backend.triage.domain.model;

import com.fasterxml.jackson.annotation.JsonUnwrapped;

import java.util.List;

/**
 * One call as triage answers it: its saved mark, ranked for the threshold the caller asked for, with the supplier calls
 * that need attention attached (their own marks, newest last).
 *
 * @param priority       1..6 for this threshold - see {@link com.fathy.alfred.backend.triage.domain.Priority}
 * @param needsAttention its own status/error/still-running says so (not counting its children or statements)
 */
public record TriageEntry(@JsonUnwrapped CallAttention call, int priority, boolean needsAttention, List<CallAttention> failingSupplierCalls) {
}
