package com.fathy.alfred.backend.dbcapture.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * A Redis command as a .json/.md/.html export carries it and a re-import reads it back (specs/011-redis-capture
 * contracts/export-and-mcp.md): every field, the exact bytes as base64 (absent for a masked key - {@code masked} says
 * so, and the bytes are never exported), and the decoded text a reader of an .md/.html export sees. Nothing is cut.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ExportedStoreCommand(
        String store,
        int seq,
        String at,
        long micros,
        String command,
        List<String> keys,
        int keysTotal,
        String rw,
        String outcome,
        String replyType,
        int resp,
        String error,
        String args,
        String reply,
        String before,
        String beforeNote,
        long argsBytes,
        long replyBytes,
        long beforeBytes,
        boolean masked,
        String client,
        String connection,
        String server,
        int db,
        String thread,
        String code,
        List<String> callers,
        StoreOrigin origin,
        StoreGroup group,
        Long poolWaitMicros,
        String fingerprint,
        String runTag,
        List<String> argsText,
        String replyFormat,
        String replyText,
        String valueFormat,
        String valueText,
        String beforeText
) {
}
