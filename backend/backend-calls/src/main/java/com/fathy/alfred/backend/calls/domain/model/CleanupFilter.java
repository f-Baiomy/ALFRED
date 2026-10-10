package com.fathy.alfred.backend.calls.domain.model;

/**
 * Which calls a storage clean-up removes - every part optional (blank = any). {@code before}: an ISO instant, calls
 * older than it. {@code project}: the project (inbound) or supplier (outbound). {@code status}: "2xx" (2xx and 3xx),
 * "4xx", "5xx" (5xx and proxy errors) or "options" (CORS preflights). {@code urlContains}: a substring of the URL.
 */
public record CleanupFilter(String before, String project, String status, String urlContains) {
}
