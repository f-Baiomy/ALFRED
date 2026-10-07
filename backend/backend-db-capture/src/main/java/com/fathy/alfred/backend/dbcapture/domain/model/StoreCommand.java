package com.fathy.alfred.backend.dbcapture.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * One store command opened in the window (specs/011-redis-capture FR-020): the row plus its full arguments as text
 * tokens, the reply and the value before the write decoded, "written by", and where it ran.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record StoreCommand(
        StoreCommandSummary row,
        List<String> args,
        DecodedValue reply,
        DecodedValue before,
        DecodedValue value,
        KeyWriter writtenBy,
        String server,
        Integer db,
        String thread,
        List<String> callers,
        String fingerprint,
        int resp,
        String argsRawBase64
) {
}
