package com.fathy.alfred.dbagent.transport;

import java.util.List;

/**
 * One Redis command a captured call sent, with its reply (specs/011-redis-capture, contracts/agent-redis-capture.md).
 * {@code args}/{@code reply}/{@code before} are the exact RESP bytes; when the command is bigger than one chunk they
 * travel as {@link RedisChunkRecord}s and are null here ({@code chunked}). The display copies {@code command} and
 * {@code keys} are cut here, so a record can never fail ALFRED's validation - the full keys are always in the bytes.
 */
public final class RedisCommandRecord {

    public static final int MAX_COMMAND_CHARS = 64;
    public static final int MAX_KEYS = 64;
    public static final int MAX_KEY_CHARS = 1024;

    public String sid;
    public String callId;
    public String runTag;
    public int seq;
    /** When sent - ISO instant with a fixed 3-digit fraction. */
    public String at;
    public long micros;
    public String command;
    public List<String> keys;
    public int keysTotal;
    public byte[] args;
    public byte[] reply;
    public String replyType;
    public int resp = 2;
    public String error;
    public long argsBytes;
    public long replyBytes;
    public boolean chunked;
    public String client;
    public String connection;
    public String server;
    public int db;
    public String thread;
    public String code;
    public List<String> callers;
    /** Spring Cache origin: cache, operation, method (null when the code sent the command itself). */
    public String originCache;
    public String originOperation;
    public String originMethod;
    /** "tx" or "pipeline", with the group's id, this command's index and the group's size (null when single). */
    public String groupKind;
    public String groupId;
    public int groupIndex;
    public int groupSize;
    /** -1 = no pool. */
    public long poolWaitMicros = -1;
    public byte[] before;
    public String beforeType;
    public String beforeNote;
    public long beforeBytes;
    public String fingerprint;

    /** Size the record holds in the agent's queue (the bytes travel base64 - a third more). */
    public long approxBytes() {
        return 256 + len(args) + len(reply) + len(before) + (keys == null ? 0 : keys.size() * 64L) + str(code) + str(thread) + str(error);
    }

    private static long len(byte[] b) {
        return b == null ? 0 : b.length * 4L / 3;
    }

    private static long str(String s) {
        return s == null ? 0 : s.length() * 2L;
    }
}
