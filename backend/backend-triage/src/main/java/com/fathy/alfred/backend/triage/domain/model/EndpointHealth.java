package com.fathy.alfred.backend.triage.domain.model;

/**
 * One endpoint's calls ({@link com.fathy.alfred.backend.triage.domain.EndpointPattern}) and how many of them carried
 * each kind of trouble: {@code errorCalls} carry at least one error signal, {@code warningCalls} only warnings.
 */
public record EndpointHealth(String endpoint, int calls, int errorCalls, int warningCalls, int httpErrors, int dbFailed, int dbWarnings,
                             int logErrors, int logWarnings, int supplierFailed, Double medianMs, Double maxMs, int redisFailed, int cacheCold) {

    public EndpointHealth(String endpoint, int calls, int errorCalls, int warningCalls, int httpErrors, int dbFailed, int dbWarnings,
                          int logErrors, int logWarnings, int supplierFailed, Double medianMs, Double maxMs) {
        this(endpoint, calls, errorCalls, warningCalls, httpErrors, dbFailed, dbWarnings, logErrors, logWarnings, supplierFailed, medianMs, maxMs, 0, 0);
    }
}
