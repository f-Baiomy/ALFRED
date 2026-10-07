package com.fathy.alfred.backend.dbcapture.domain;

import com.fathy.alfred.backend.dbcapture.domain.model.IncomingStoreCommand;
import com.fathy.alfred.backend.dbcapture.domain.model.StoredKey;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * What ALFRED derives from a Redis command when it is stored (specs/011-redis-capture data-model.md): read / write /
 * other, the outcome (HIT, MISS, OK, FAILED), a short reply preview for list rows, the row of each key it touched with
 * the hash of the value read or written and the TTL a write set - the basis of "written by", key history and
 * "cache cold". Pure.
 */
public final class StoreCommandFacts {

    static final int PREVIEW_CHARS = 200;

    private static final Set<String> READS = Set.of("GET", "MGET", "GETEX", "HGET", "HGETALL", "HMGET", "HKEYS", "HVALS", "HLEN",
            "HEXISTS", "HSTRLEN", "LRANGE", "LLEN", "LINDEX", "LPOS", "SMEMBERS", "SISMEMBER", "SMISMEMBER", "SCARD", "SRANDMEMBER",
            "SINTER", "SUNION", "SDIFF", "ZRANGE", "ZRANGEBYSCORE", "ZREVRANGE", "ZREVRANGEBYSCORE", "ZSCORE", "ZMSCORE", "ZCARD",
            "ZRANK", "ZREVRANK", "ZCOUNT", "EXISTS", "TTL", "PTTL", "TYPE", "STRLEN", "GETRANGE", "GETBIT", "BITCOUNT", "PFCOUNT",
            "XRANGE", "XREVRANGE", "XLEN", "XREAD", "SCAN", "HSCAN", "SSCAN", "ZSCAN", "KEYS", "DUMP", "OBJECT ENCODING", "EXPIRETIME");
    private static final Set<String> WRITES = Set.of("SET", "SETNX", "SETEX", "PSETEX", "GETSET", "GETDEL", "APPEND", "SETRANGE",
            "INCR", "INCRBY", "INCRBYFLOAT", "DECR", "DECRBY", "MSET", "MSETNX", "HSET", "HSETNX", "HMSET", "HDEL", "HINCRBY",
            "HINCRBYFLOAT", "LPUSH", "RPUSH", "LPUSHX", "RPUSHX", "LPOP", "RPOP", "LSET", "LREM", "LTRIM", "LINSERT", "LMOVE",
            "RPOPLPUSH", "BLPOP", "BRPOP", "BLMOVE", "BRPOPLPUSH", "SADD", "SREM", "SPOP", "SMOVE", "ZADD", "ZREM", "ZINCRBY",
            "ZPOPMIN", "ZPOPMAX", "BZPOPMIN", "BZPOPMAX", "DEL", "UNLINK", "EXPIRE", "PEXPIRE", "EXPIREAT", "PEXPIREAT", "PERSIST",
            "RENAME", "RENAMENX", "COPY", "RESTORE", "EVAL", "EVALSHA", "FCALL", "XADD", "XDEL", "XTRIM", "SETBIT", "PFADD",
            "PFMERGE", "SINTERSTORE", "SUNIONSTORE", "SDIFFSTORE", "FLUSHDB", "FLUSHALL");
    /** Writes that store a whole string value - "same value as written" compares their value with a later GET. */
    private static final Set<String> STRING_VALUE = Set.of("SET", "SETNX", "SETEX", "PSETEX", "GETSET", "MSET", "MSETNX");
    private static final Set<String> STRING_READ = Set.of("GET", "GETEX", "GETDEL", "MGET", "GETSET");

    private StoreCommandFacts() {
    }

    public static String rw(String command) {
        String c = command == null ? "" : command.toUpperCase(Locale.ROOT);
        return READS.contains(c) ? "r" : WRITES.contains(c) ? "w" : "o";
    }

    public static String outcome(IncomingStoreCommand c, byte[] reply) {
        String type = c.replyType() == null ? Resp.type(reply) : c.replyType();
        if ((c.error() != null && !c.error().isBlank()) || "ERROR".equals(type) || "NONE".equals(type)) {
            return "FAILED";
        }
        if (!"r".equals(rw(c.command()))) {
            return "OK";
        }
        if ("NIL".equals(type) || "NIL_ARRAY".equals(type)) {
            return "MISS";
        }
        if (reply != null && Resp.empty(reply)) {
            return "MISS";
        }
        if ("EXISTS".equalsIgnoreCase(c.command()) && reply != null && new String(reply, StandardCharsets.US_ASCII).startsWith(":0")) {
            return "MISS";
        }
        return "HIT";
    }

    public static String replyPreview(String outcome, byte[] reply, String error) {
        if (reply == null || reply.length == 0) {
            return error == null ? "" : error;
        }
        String p = Resp.preview(reply, PREVIEW_CHARS);
        if ("HIT".equals(outcome) && reply[0] == '$') {
            Resp.Value v = Resp.parse(reply);
            long n = v == null || v.scalar() == null ? 0 : v.scalar().length;
            return "HIT " + size(n);
        }
        if ("MISS".equals(outcome)) {
            return "MISS " + p;
        }
        return p;
    }

    /** {@code 1.4 KB}, {@code 300 B}, {@code 1.8 MB}. */
    public static String size(long bytes) {
        if (bytes < 1024) {
            return bytes + " B";
        }
        if (bytes < 1024 * 1024) {
            return String.format(Locale.ROOT, "%.1f KB", bytes / 1024.0);
        }
        return String.format(Locale.ROOT, "%.1f MB", bytes / (1024.0 * 1024));
    }

    /** The arguments after the name (and the two-word sub-command) and the keys, each cut to 80 characters - for the row. */
    public static String argsText(String command, List<byte[]> args, int keyCount) {
        int skip = (command != null && command.contains(" ") ? 2 : 1);
        if ("MSET".equalsIgnoreCase(command) || "MSETNX".equalsIgnoreCase(command) || "HSET".equalsIgnoreCase(command)) {
            skip += 1; // the values interleave with keys/fields: show them after the first key
        } else {
            skip += Math.min(keyCount, 1);
        }
        StringBuilder out = new StringBuilder();
        for (int i = skip; i < args.size() && out.length() < 240; i++) {
            if (out.length() > 0) {
                out.append(' ');
            }
            byte[] a = args.get(i);
            String t = Resp.utf8(a);
            if (t == null) {
                out.append("‹").append(size(a.length)).append("›");
            } else if (a.length > 80) {
                out.append("‹").append(size(a.length)).append("›");
            } else {
                out.append(t.contains(" ") || t.isEmpty() ? "\"" + t + "\"" : t);
            }
        }
        return out.length() > 240 ? out.substring(0, 239) + "…" : out.toString();
    }

    /** One row per key the command touched (data-model store_keys). Other commands (PUBLISH, SCRIPT…) touch none. */
    public static List<StoredKey> keys(String project, IncomingStoreCommand c, byte[] args, byte[] reply, String outcome) {
        String rw = rw(c.command());
        if ("o".equals(rw) && !c.command().toUpperCase(Locale.ROOT).startsWith("EVAL")) {
            return List.of();
        }
        String op = "r".equals(rw) ? "r" : "w";
        long at = atMs(c.at());
        List<byte[]> argv = args == null ? List.of() : Resp.args(args);
        String cmd = c.command().toUpperCase(Locale.ROOT);
        Long ttl = ttlOf(cmd, argv);
        List<StoredKey> out = new ArrayList<>();
        List<String> keys = c.keys();
        Resp.Value parsedReply = reply == null ? null : Resp.parse(reply);
        for (int i = 0; i < keys.size(); i++) {
            String hash = null;
            if ("w".equals(op) && STRING_VALUE.contains(cmd) && !"FAILED".equals(outcome)) {
                byte[] value = valueArg(cmd, argv, i);
                hash = value == null ? null : sha256(value);
            } else if ("r".equals(op) && STRING_READ.contains(cmd) && "HIT".equals(outcome) && parsedReply != null) {
                byte[] value = "MGET".equals(cmd) && parsedReply.isAggregate() && i < parsedReply.elements().size()
                        ? parsedReply.elements().get(i).scalar() : parsedReply.scalar();
                hash = value == null ? null : sha256(value);
            }
            out.add(new StoredKey(project, keys.get(i), c.callId(), c.seq(), op, at, hash, "w".equals(op) ? ttl : null));
        }
        return out;
    }

    /** The value a string write stores for its i-th key. */
    static byte[] valueArg(String cmd, List<byte[]> argv, int keyIndex) {
        int at = switch (cmd) {
            case "SET", "SETNX", "GETSET" -> 2;
            case "SETEX", "PSETEX" -> 3;
            case "MSET", "MSETNX" -> 2 + keyIndex * 2;
            default -> -1;
        };
        return at > 0 && at < argv.size() ? argv.get(at) : null;
    }

    /** The TTL (ms) a write sets: SET … EX/PX, SETEX, PSETEX, EXPIRE, PEXPIRE. */
    static Long ttlOf(String cmd, List<byte[]> argv) {
        try {
            switch (cmd) {
                case "SETEX":
                    return argv.size() > 2 ? Long.parseLong(ascii(argv.get(2))) * 1000 : null;
                case "PSETEX":
                    return argv.size() > 2 ? Long.parseLong(ascii(argv.get(2))) : null;
                case "EXPIRE":
                    return argv.size() > 2 ? Long.parseLong(ascii(argv.get(2))) * 1000 : null;
                case "PEXPIRE":
                    return argv.size() > 2 ? Long.parseLong(ascii(argv.get(2))) : null;
                case "SET":
                    for (int i = 3; i + 1 < argv.size(); i++) {
                        String o = ascii(argv.get(i)).toUpperCase(Locale.ROOT);
                        if (o.equals("EX")) {
                            return Long.parseLong(ascii(argv.get(i + 1))) * 1000;
                        }
                        if (o.equals("PX")) {
                            return Long.parseLong(ascii(argv.get(i + 1)));
                        }
                    }
                    return null;
                default:
                    return null;
            }
        } catch (NumberFormatException e) {
            return null;
        }
    }

    public static long atMs(String at) {
        if (at == null) {
            return 0;
        }
        try {
            return Instant.parse(at).toEpochMilli();
        } catch (RuntimeException e) {
            return 0;
        }
    }

    public static String sha256(byte[] value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String ascii(byte[] b) {
        return new String(b, StandardCharsets.ISO_8859_1);
    }
}
