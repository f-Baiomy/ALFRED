package com.fathy.alfred.backend.dbcapture.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;
import java.util.Map;

/**
 * One flagged problem in a call. {@code seqs} are the statements it is about (the first is where "jump" goes);
 * {@code group} names a transaction or a repeated-query fingerprint when the flag is about a group;
 * {@code detail} carries the few values the label needs (table, count, milliseconds, error code).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record DbFlag(DbFlagType type, String severity, List<Integer> seqs, String group, Map<String, String> detail) {

    public static final String BAD = "BAD";
    public static final String WARN = "WARN";
}
