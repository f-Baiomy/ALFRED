package com.fathy.alfred.backend.internalcalls.domain.model;

/**
 * How one INBOUND endpoint normally performs - the mirror of backend-calls' CallBaseline, duplicated
 * rather than shared because the two slices are isolated from each other by Maven module boundaries
 * and ArchUnit (see docs/architecture.md).
 *
 * <p>Sample size matters more here than on the outbound side: internal calls live in a ring-buffered
 * file capped at alfred.internal-calls.max-limit, so this is a baseline over recent traffic only,
 * never the whole history.
 */
public record CallBaseline(String url, int sampleSize, Double p50Ms, Double p95Ms) {

    public static CallBaseline empty(String url) {
        return new CallBaseline(url, 0, null, null);
    }
}
