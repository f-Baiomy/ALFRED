package com.fathy.alfred.backend.logs.domain.model;

import java.util.Map;

/**
 * One line ready to store: original text per field index, typed value per typed field index, and
 * everything derived at ingest (time, level, group placement, pattern, structure).
 *
 * @param text        field index → original value as text (JSON null and absent are both absent)
 * @param typed       field index → epoch ms / double / 0-1 for typed fields that converted
 * @param ftsText     the Text-search fields joined with newlines (what the trigram index holds)
 * @param raw         the original line in COPY mode; null in OFFSET mode
 * @param shape       the structure this line belongs to ({@link LineShape}); 0 for an unparsed line
 * @param bytes       length of the raw line - drives size-based retention
 */
public record LineRecord(
        String lineId,
        String inputId,
        long byteOffset,
        long ts,
        String level,
        int groupLevel,
        String groupPath,
        String missingLevel,
        long patternId,
        double duration,
        Map<Integer, String> text,
        Map<Integer, Object> typed,
        String ftsText,
        String raw,
        boolean unparsed,
        int shape,
        int bytes
) {
}
