package com.fathy.alfred.backend.logs.domain.model;

import java.util.Map;

/**
 * A list row: only the fields a row shows (roles, template tokens, chosen columns, level IDs) -
 * never the raw line or every field (constitution II: summaries for lists). Full data comes from
 * {@link LogLine}.
 */
public record LogLineSummary(
        String lineId,
        long ts,
        String level,
        int groupLevel,
        String groupPath,
        String missingLevel,
        boolean pinned,
        boolean unparsed,
        int shape,
        Map<String, Object> fields,
        int commentCount
) {
}
