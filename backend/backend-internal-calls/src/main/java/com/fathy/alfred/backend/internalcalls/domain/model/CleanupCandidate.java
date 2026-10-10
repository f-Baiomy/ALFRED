package com.fathy.alfred.backend.internalcalls.domain.model;

/**
 * One call a clean-up would remove, with roughly how many bytes it holds (bodies and headers), and its two body
 * sizes - with method, URL and status what tells a repeated call from a different one.
 */
public record CleanupCandidate(String id, String method, String url, Integer status, String timestamp, String project, long bytes,
                               long requestBodyBytes, long responseBodyBytes) {

    public CleanupCandidate(String id, String method, String url, Integer status, String timestamp, String project, long bytes) {
        this(id, method, url, status, timestamp, project, bytes, 0, 0);
    }
}
