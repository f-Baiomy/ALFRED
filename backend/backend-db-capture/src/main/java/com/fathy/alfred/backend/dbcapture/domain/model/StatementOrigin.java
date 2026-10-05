package com.fathy.alfred.backend.dbcapture.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * Where a statement came from when an ORM made it (contracts/agent-ingest.md): the query the code wrote - HQL/JPQL,
 * native SQL, Criteria - with its parameters, name and paging, or the Hibernate event that made SQL on its own
 * (LAZY_LOAD, LOAD, FLUSH, or HIBERNATE for anything else of Hibernate's). Absent for plain JDBC. Statements of one
 * query execution share {@code id}; an event that ran inside a query names it in {@code parentId}.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record StatementOrigin(
        String id,
        String kind,
        String text,
        String name,
        String method,
        List<Param> params,
        Integer firstResult,
        Integer maxResults,
        String entity,
        String entityId,
        String role,
        String action,
        List<String> changed,
        String parentId
) {
    /** A bound parameter as the code named it ({@code :branchId}) or numbered it ({@code ?1}), value as displayed. */
    public record Param(String name, String value) {
    }
}
