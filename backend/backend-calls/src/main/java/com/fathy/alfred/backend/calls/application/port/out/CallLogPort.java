package com.fathy.alfred.backend.calls.application.port.out;

import com.fathy.alfred.backend.calls.application.service.CallListSupport;
import com.fathy.alfred.backend.calls.domain.model.CallRecord;
import com.fathy.alfred.backend.calls.domain.model.CallStatusBreakdown;
import com.fathy.alfred.backend.calls.domain.model.CallSummary;
import com.fathy.alfred.backend.calls.domain.model.ResponseData;

import java.util.List;
import java.util.Optional;

/** Outbound port: how the application core reads and persists logged calls, without knowing whether they live in a flat file or a database. */
public interface CallLogPort {

    /** All logged calls, in file order (oldest first). Only cheap for adapters that hold everything in memory (the file adapter) - the SQLite adapter still supports it, but {@link #query} is what CallsService actually uses for GET /calls. */
    List<CallRecord> readAll();

    /** Persists one newly-received call (appended, not upserted - each call is its own record). */
    void save(CallRecord call);

    /**
     * First half of two-phase logging: persists {@code call} with {@code state == IN_PROGRESS}
     * (response/error/durationMs all null) the moment the proxy intercepts a request, before the
     * upstream has responded. {@code call.id()} is already assigned by the caller.
     */
    void prepare(CallRecord call);

    /**
     * Second half: fills in the outcome of a previously-{@link #prepare}d call - either
     * {@code response} (a real HTTP reply, any status code) or {@code error} (the proxy never got
     * one), never both. @return true if a call with this id was found and updated, false if not
     * (already trimmed by retention, or never prepared - the caller should treat this as a 404).
     */
    boolean complete(String id, ResponseData response, String error, Double durationMs);

    /**
     * Filtered/searched/sorted/paginated call summaries, plus the total count matching before
     * pagination - returns {@link CallSummary} (not the full {@link CallRecord}) since list/search
     * views never need request/response headers/bodies; a SQL-backed adapter can then skip
     * fetching those large columns entirely instead of loading and immediately discarding them.
     * Same filter/sort/paginate contract as {@link CallListSupport#apply}, so every adapter
     * (file-backed, in-memory over readAll(), or SQL-backed, pushed down into the query itself)
     * behaves identically from CallsService's point of view.
     */
    CallListSupport.Page<CallSummary> query(String search, String supplier, String sort, int offset, int limit, boolean paginationEnabled);

    /** A single call by id, or empty if no call with that id has ever been logged. */
    Optional<CallRecord> findById(String id);

    /** Bytes currently occupied on disk by this adapter's storage - drives the Database settings tab's file-size table. */
    long storageSizeBytes();

    /** Counts of every logged call grouped into ok (2xx/3xx) / client error (4xx) / server error (5xx or a captured proxy error) - drives the Database settings tab's status donut. */
    CallStatusBreakdown statusBreakdown();

    /** Permanently deletes every logged call - the Database settings tab's "Clear calls" action. */
    void deleteAll();
}
