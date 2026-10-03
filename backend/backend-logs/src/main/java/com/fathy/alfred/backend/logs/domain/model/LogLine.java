package com.fathy.alfred.backend.logs.domain.model;

import java.util.Map;

/**
 * A line in full: every stored field by label plus the raw line exactly as received.
 *
 * @param raw            the original line; null when it cannot be read (see rawUnavailable)
 * @param rawUnavailable why the raw line cannot be shown (positions-only mode and the original file
 *                       moved or changed) - the stored fields stay searchable either way
 */
public record LogLine(
        String lineId,
        String inputId,
        long byteOffset,
        long ts,
        String level,
        int groupLevel,
        String groupPath,
        String missingLevel,
        boolean pinned,
        boolean unparsed,
        int shape,
        Map<String, Object> fields,
        String raw,
        String rawUnavailable
) {
}
