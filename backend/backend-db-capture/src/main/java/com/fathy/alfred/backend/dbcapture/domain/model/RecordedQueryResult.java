package com.fathy.alfred.backend.dbcapture.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/** A page of a recorded-data query. {@code error} is the user's query being wrong - shown, not a failure. */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record RecordedQueryResult(List<String> columns, List<List<String>> rows, long total, List<Integer> statementSeqs, String error) {
    public static RecordedQueryResult failed(String error) {
        return new RecordedQueryResult(List.of(), List.of(), 0, null, error);
    }
}
