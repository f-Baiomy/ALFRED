package com.fathy.alfred.backend.dbcapture.domain.model;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * What a statement produced, minus the rows themselves (those are paged from their own table). One record with a
 * {@link OutcomeKind} tag rather than a sealed hierarchy: it is stored as JSON and travels to the frontend as JSON,
 * and a flat optional-field shape is what both ends read most simply. Which fields are set depends on the kind:
 *
 * <ul>
 *   <li>ROWS - columns, rowsRead (what the application actually read), partial (it stopped before the end),
 *       overLimit (rows past the per-result limit were counted, not stored)</li>
 *   <li>UPDATED - affected, perSet (a batch's count per parameter set), generatedKeys</li>
 *   <li>PROCEDURE - outParams, plus columns/rowsRead when it returned a result set</li>
 *   <li>FAILED - sqlState, vendorCode, message, chain; swallowed is decided when the call completes</li>
 *   <li>TX_END - txResult (COMMITTED / ROLLED_BACK), heldMicros</li>
 * </ul>
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record StatementOutcome(
        OutcomeKind kind,
        List<Column> columns,
        Long rowsRead,
        Boolean partial,
        Boolean overLimit,
        Long affected,
        List<Long> perSet,
        List<List<TypedValue>> generatedKeys,
        List<TypedValue> outParams,
        String sqlState,
        Integer vendorCode,
        String message,
        List<String> chain,
        Boolean swallowed,
        String txResult,
        Long heldMicros
) {
    @JsonIgnore
    public boolean failed() {
        return kind == OutcomeKind.FAILED;
    }

    @JsonIgnore
    public boolean rolledBack() {
        return kind == OutcomeKind.TX_END && "ROLLED_BACK".equals(txResult);
    }

    public StatementOutcome withSwallowed(boolean value) {
        return new StatementOutcome(kind, columns, rowsRead, partial, overLimit, affected, perSet, generatedKeys, outParams,
                sqlState, vendorCode, message, chain, value, txResult, heldMicros);
    }
}
