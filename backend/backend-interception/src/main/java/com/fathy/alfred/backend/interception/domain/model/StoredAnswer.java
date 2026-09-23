package com.fathy.alfred.backend.interception.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * A response kept by Alfred so a rule can answer with it: one copied from a recorded call
 * (RECORDED), or one uploaded as a file (FILE). The body is stored and published separately - this
 * is only what describes it, which is what every list and every rule editor card reads.
 *
 * <p>Immutable once created. A rule that needs a different answer gets a new one, so a proxy that
 * already holds {@code answers/<id>.body} never has to wonder whether it is stale.
 *
 * @param headers     RECORDED: the recorded headers, minus the secrets the user chose to strip
 *                    and minus the framing headers a decoded body no longer matches. FILE: only
 *                    {@code content-type}.
 * @param secretsKept null when there were no secrets to decide about (and for FILE); otherwise
 *                    whether the user chose to keep them.
 * @param secretNames the secret header names found at copy time - names only, never values.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record StoredAnswer(
        String id,
        Kind kind,
        Integer status,
        Map<String, String> headers,
        String contentType,
        long sizeBytes,
        Boolean secretsKept,
        List<String> secretNames,
        String sourceDirection,
        String sourceCallId,
        String sourceCycleId,
        String recordedAt,
        String createdAt) {

    public enum Kind { RECORDED, FILE }

    /**
     * A canonical lowercase UUID and nothing else. The id becomes a file name in the published
     * {@code answers/} directory and in the file store, so this is the path-traversal guard: an id
     * that does not match is never looked up, joined onto a directory or written anywhere.
     */
    private static final Pattern ID = Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");

    public StoredAnswer {
        headers = headers == null ? Map.of() : Map.copyOf(headers);
        secretNames = secretNames == null ? List.of() : List.copyOf(secretNames);
    }

    public static boolean isValidId(String id) {
        return id != null && ID.matcher(id).matches();
    }
}
