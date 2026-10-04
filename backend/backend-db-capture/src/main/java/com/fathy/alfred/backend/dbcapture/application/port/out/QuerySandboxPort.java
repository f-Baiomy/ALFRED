package com.fathy.alfred.backend.dbcapture.application.port.out;

import com.fathy.alfred.backend.dbcapture.domain.model.RecordedQueryResult;

import java.util.List;

/**
 * Runs one read-only SELECT over a small table built from recorded data, in a throwaway in-memory database - it can
 * see nothing else. {@code params} are bound to the query's {@code ?}s (generated searches); a user's SQL has none.
 */
public interface QuerySandboxPort {
    RecordedQueryResult run(String table, List<String> columns, List<List<Object>> rows, String sql, List<Object> params, int offset, int limit);
}
