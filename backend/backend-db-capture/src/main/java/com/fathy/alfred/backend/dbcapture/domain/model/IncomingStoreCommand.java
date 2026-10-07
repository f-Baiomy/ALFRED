package com.fathy.alfred.backend.dbcapture.domain.model;

import java.util.List;

/**
 * One store command as an agent sends it (specs/011-redis-capture contracts/agent-redis-capture.md). The byte arrays
 * are the exact RESP request / reply / value-before-the-write; null when they travel as chunks ({@code chunked}) or
 * do not exist. {@code keys} is the display copy (at most 64, each cut to 1,024 characters) - {@code keysTotal} the
 * real count; the full keys are always in {@code args}.
 */
public record IncomingStoreCommand(
        String store,
        String sid,
        String callId,
        String runTag,
        int seq,
        String at,
        long micros,
        String command,
        List<String> keys,
        int keysTotal,
        byte[] args,
        byte[] reply,
        String replyType,
        int resp,
        String error,
        long argsBytes,
        long replyBytes,
        boolean chunked,
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
        byte[] before,
        String beforeType,
        String beforeNote,
        long beforeBytes,
        String fingerprint
) {
    public IncomingStoreCommand {
        keys = keys == null ? List.of() : keys;
        callers = callers == null ? List.of() : callers;
        store = store == null ? "redis" : store;
    }

    /** The same command with its bytes - parts assembled by the store, or an imported command. */
    public IncomingStoreCommand withBytes(byte[] argsBytes, byte[] replyBytes, byte[] beforeBytes) {
        return new IncomingStoreCommand(store, sid, callId, runTag, seq, at, micros, command, keys, keysTotal, argsBytes, replyBytes,
                replyType, resp, error, this.argsBytes, this.replyBytes, false, client, connection, server, db, thread, code, callers,
                origin, group, poolWaitMicros, beforeBytes, beforeType, beforeNote, this.beforeBytes, fingerprint);
    }
}
