package com.fathy.alfred.dbagent.transport;

/**
 * One part of a big command's bytes (specs/011-redis-capture research R4): {@code which} is "args", "reply" or
 * "before"; parts are numbered from 0 of {@code of}. ALFRED shows the command only once every part and its record
 * arrived, so a value is either stored whole or not at all - never shortened.
 */
public final class RedisChunkRecord {

    /** Bytes per part - with base64 and JSON well under ALFRED's batch limit even at the batch's part count. */
    public static final int PART_BYTES = 256 * 1024;

    public final String sid;
    public final String which;
    public final int part;
    public final int of;
    public final byte[] data;

    public RedisChunkRecord(String sid, String which, int part, int of, byte[] data) {
        this.sid = sid;
        this.which = which;
        this.part = part;
        this.of = of;
        this.data = data;
    }

    public long approxBytes() {
        return 64 + data.length * 4L / 3;
    }
}
