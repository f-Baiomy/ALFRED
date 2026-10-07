package com.fathy.alfred.backend.dbcapture.adapter.in.web.dto;

import com.fathy.alfred.backend.dbcapture.domain.model.IncomingStoreCommand;
import com.fathy.alfred.backend.dbcapture.domain.model.StoreGroup;
import com.fathy.alfred.backend.dbcapture.domain.model.StoreOrigin;

import java.util.Base64;
import java.util.List;

/**
 * One Redis command in an agent batch (specs/011-redis-capture contracts/agent-redis-capture.md). Deliberately without
 * Bean Validation limits: one odd command must never reject a whole batch (statements and log lines included) - the
 * service checks each command on its own and stores a bad one as "invalid record" (data-model.md "Validation"). The
 * agent already cuts the display copies (command, keys); args/reply/before are base64 of the exact bytes.
 */
public record RedisCommandDto(
        String sid,
        String callId,
        String runTag,
        int seq,
        String at,
        long micros,
        String command,
        List<String> keys,
        int keysTotal,
        String args,
        String reply,
        String replyType,
        int resp,
        String error,
        long argsBytes,
        long replyBytes,
        Boolean chunked,
        String client,
        String connection,
        String server,
        int db,
        String thread,
        String code,
        List<String> callers,
        OriginDto origin,
        GroupDto group,
        Long poolWaitMicros,
        String before,
        String beforeType,
        String beforeNote,
        long beforeBytes,
        String fingerprint
) {
    public record OriginDto(String store, String cache, String operation, String method) {
    }

    public record GroupDto(String kind, String id, int index, int size) {
    }

    /** Throws IllegalArgumentException for bytes that are not base64 - the service turns that into an invalid record. */
    public IncomingStoreCommand toDomain() {
        return new IncomingStoreCommand("redis", sid, callId, runTag, seq, at, micros, command, keys, keysTotal, bytes(args), bytes(reply),
                replyType, resp == 0 ? 2 : resp, error, argsBytes, replyBytes, Boolean.TRUE.equals(chunked), client, connection, server, db,
                thread, code, callers, origin == null ? null : new StoreOrigin(origin.store(), origin.cache(), origin.operation(), origin.method()),
                group == null ? null : new StoreGroup(group.kind(), group.id(), group.index(), group.size()), poolWaitMicros, bytes(before),
                beforeType, beforeNote, beforeBytes, fingerprint);
    }

    /** The same command with its bytes left out - for a record whose base64 could not be read. */
    public RedisCommandDto withoutBytes() {
        return new RedisCommandDto(sid, callId, runTag, seq, at, micros, command, keys, keysTotal, null, null, "NONE", resp, error, 0, 0,
                false, client, connection, server, db, thread, code, callers, origin, group, poolWaitMicros, null, beforeType, beforeNote, 0,
                fingerprint);
    }

    private static byte[] bytes(String base64) {
        return base64 == null ? null : Base64.getDecoder().decode(base64);
    }
}
