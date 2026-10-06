package com.fathy.alfred.dbagent.capture;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * The Redis wire format (RESP 2 and 3) as the agent needs it (specs/011-redis-capture, research R3): framing a
 * request from its arguments, splitting what an encoder wrote into commands, a reply's type, which arguments are keys,
 * a key's pattern and a command's fingerprint. Pure - no client classes. The backend has its own reader of the same
 * bytes; both are tested against specs/011-redis-capture/fixtures/resp-cases.json so they cannot drift.
 */
public final class RespFrame {

    static final String CREDENTIALS = "‹credentials not stored›";

    /** Commands whose first argument is a sub-command, shown as two words ("CLIENT SETNAME"). */
    private static final Set<String> TWO_WORD = set("CLIENT", "SCRIPT", "CONFIG", "CLUSTER", "OBJECT", "MEMORY", "XGROUP",
            "XINFO", "COMMAND", "FUNCTION", "ACL", "PUBSUB", "MODULE", "SLOWLOG", "LATENCY");
    /** Every argument is a key. */
    private static final Set<String> ALL_KEYS = set("MGET", "DEL", "UNLINK", "EXISTS", "TOUCH", "WATCH", "SUNION", "SINTER",
            "SDIFF", "PFCOUNT", "PFMERGE", "SUNIONSTORE", "SINTERSTORE", "SDIFFSTORE");
    /** The first two arguments are keys. */
    private static final Set<String> TWO_KEYS = set("RENAME", "RENAMENX", "SMOVE", "RPOPLPUSH", "LMOVE", "COPY", "BRPOPLPUSH", "BLMOVE");
    /** All arguments but the last (a timeout) are keys. */
    private static final Set<String> KEYS_THEN_TIMEOUT = set("BLPOP", "BRPOP", "BZPOPMIN", "BZPOPMAX");
    /** EVAL-like: numkeys is the second argument, the keys follow. */
    private static final Set<String> NUMKEYS = set("EVAL", "EVALSHA", "EVAL_RO", "EVALSHA_RO", "FCALL", "FCALL_RO");
    /** No key at all. */
    private static final Set<String> NO_KEY = set("PING", "AUTH", "HELLO", "SELECT", "MULTI", "EXEC", "DISCARD", "UNWATCH",
            "INFO", "CLIENT", "SCRIPT", "CONFIG", "KEYS", "SCAN", "FLUSHDB", "FLUSHALL", "DBSIZE", "TIME", "QUIT", "COMMAND",
            "READONLY", "READWRITE", "ECHO", "RESET", "CLUSTER", "FUNCTION", "ACL", "PUBSUB", "SUBSCRIBE", "PSUBSCRIBE",
            "UNSUBSCRIBE", "PUNSUBSCRIBE", "WAIT", "SAVE", "BGSAVE", "LASTSAVE", "SWAPDB", "MEMORY", "MODULE", "SLOWLOG",
            "LATENCY", "ROLE", "MONITOR");
    /** Connection set-up and health checks - not recorded unless the project asks (FR-007). */
    private static final Set<String> HOUSEKEEPING = set("PING", "AUTH", "HELLO", "CLIENT", "SELECT", "READONLY", "READWRITE",
            "COMMAND", "QUIT", "RESET");

    private RespFrame() {
    }

    private static Set<String> set(String... names) {
        return Collections.unmodifiableSet(new HashSet<>(Arrays.asList(names)));
    }

    // ------------------------------------------------------------------ requests

    /** The RESP array of bulk strings a client writes for these arguments (the command name first). */
    static byte[] request(List<byte[]> args) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(64);
        writeAscii(out, "*" + args.size() + "\r\n");
        for (byte[] a : args) {
            byte[] v = a == null ? new byte[0] : a;
            writeAscii(out, "$" + v.length + "\r\n");
            out.write(v, 0, v.length);
            writeAscii(out, "\r\n");
        }
        return out.toByteArray();
    }

    /** The arguments of one request (an array of bulk strings), or null when {@code b[from..to)} is not one. */
    static List<byte[]> args(byte[] b, int from, int to) {
        int[] pos = {from};
        if (from >= to || b[from] != '*') {
            return null;
        }
        pos[0]++;
        long n = readLong(b, pos, to);
        if (n < 0) {
            return null;
        }
        List<byte[]> out = new ArrayList<>((int) Math.min(n, 1024));
        for (long i = 0; i < n; i++) {
            if (pos[0] >= to || b[pos[0]] != '$') {
                return null;
            }
            pos[0]++;
            long len = readLong(b, pos, to);
            if (len < 0 || pos[0] + len + 2 > to) {
                return null;
            }
            out.add(Arrays.copyOfRange(b, pos[0], (int) (pos[0] + len)));
            pos[0] += (int) len + 2;
        }
        return out;
    }

    /** Where one complete RESP value starting at {@code from} ends (exclusive), or -1 when incomplete or not RESP. */
    static int frameEnd(byte[] b, int from, int to) {
        int[] pos = {from};
        return skip(b, pos, to) ? pos[0] : -1;
    }

    private static boolean skip(byte[] b, int[] pos, int to) {
        if (pos[0] >= to) {
            return false;
        }
        byte t = b[pos[0]++];
        switch (t) {
            case '+': case '-': case ':': case ',': case '#': case '(': case '_':
                return skipLine(b, pos, to);
            case '$': case '!': case '=': {
                long len = readLong(b, pos, to);
                if (len == Long.MIN_VALUE) {
                    return false;
                }
                if (len < 0) {
                    return true;
                }
                if (pos[0] + len + 2 > to) {
                    return false;
                }
                pos[0] += (int) len + 2;
                return true;
            }
            case '*': case '~': case '>': case '%': case '|': {
                long n = readLong(b, pos, to);
                if (n == Long.MIN_VALUE) {
                    return false;
                }
                long items = n < 0 ? 0 : (t == '%' || t == '|') ? n * 2 : n;
                for (long i = 0; i < items; i++) {
                    if (!skip(b, pos, to)) {
                        return false;
                    }
                }
                // an attribute frame precedes the value it describes
                return t != '|' || skip(b, pos, to);
            }
            default:
                return false;
        }
    }

    private static boolean skipLine(byte[] b, int[] pos, int to) {
        for (int i = pos[0]; i + 1 < to; i++) {
            if (b[i] == '\r' && b[i + 1] == '\n') {
                pos[0] = i + 2;
                return true;
            }
        }
        return false;
    }

    /** Reads digits up to CRLF; Long.MIN_VALUE when malformed or incomplete. */
    private static long readLong(byte[] b, int[] pos, int to) {
        int start = pos[0];
        for (int i = start; i + 1 < to; i++) {
            if (b[i] == '\r' && b[i + 1] == '\n') {
                try {
                    long v = Long.parseLong(new String(b, start, i - start, StandardCharsets.US_ASCII));
                    pos[0] = i + 2;
                    return v;
                } catch (NumberFormatException e) {
                    return Long.MIN_VALUE;
                }
            }
        }
        return Long.MIN_VALUE;
    }

    // ------------------------------------------------------------------ replies

    /** The reply's top-level RESP type (data-model.md replyType). An attribute frame is looked through. */
    public static String type(byte[] reply) {
        if (reply == null || reply.length == 0) {
            return "NONE";
        }
        int at = 0;
        if (reply[0] == '|') {
            int end = attributeEnd(reply);
            if (end < 0 || end >= reply.length) {
                return "NONE";
            }
            at = end;
        }
        switch (reply[at]) {
            case '+': return "SIMPLE";
            case '-': case '!': return "ERROR";
            case ':': return "INTEGER";
            case '$': return reply.length > at + 1 && reply[at + 1] == '-' ? "NIL" : "BULK";
            case '*': return reply.length > at + 1 && reply[at + 1] == '-' ? "NIL_ARRAY" : "ARRAY";
            case '%': return "MAP";
            case '~': return "SET";
            case ',': return "DOUBLE";
            case '#': return "BOOLEAN";
            case '(': return "BIG_NUMBER";
            case '=': return "VERBATIM";
            case '>': return "PUSH";
            case '_': return "NIL";
            default: return "NONE";
        }
    }

    private static int attributeEnd(byte[] reply) {
        int[] pos = {1};
        long n = readLong(reply, pos, reply.length);
        if (n < 0) {
            return -1;
        }
        for (long i = 0; i < n * 2; i++) {
            if (!skip(reply, pos, reply.length)) {
                return -1;
            }
        }
        return pos[0];
    }

    /** 3 when the reply uses a RESP3-only type. */
    static int version(byte[] reply) {
        if (reply == null || reply.length == 0) {
            return 2;
        }
        return "%~,#(=>_!|".indexOf(reply[0]) >= 0 ? 3 : 2;
    }

    /** The text of an error reply ({@code -ERR …} or a blob error), else null. */
    static String errorText(byte[] reply) {
        if (reply == null || reply.length == 0) {
            return null;
        }
        if (reply[0] == '-') {
            int end = indexOfCrlf(reply, 1);
            return new String(reply, 1, (end < 0 ? reply.length : end) - 1, StandardCharsets.UTF_8);
        }
        if (reply[0] == '!') {
            int[] pos = {1};
            long len = readLong(reply, pos, reply.length);
            if (len >= 0 && pos[0] + len <= reply.length) {
                return new String(reply, pos[0], (int) len, StandardCharsets.UTF_8);
            }
        }
        return null;
    }

    private static int indexOfCrlf(byte[] b, int from) {
        for (int i = from; i + 1 < b.length; i++) {
            if (b[i] == '\r' && b[i + 1] == '\n') {
                return i;
            }
        }
        return -1;
    }

    // ------------------------------------------------------------------ commands, keys, fingerprints

    /** The command's display name, upper case - two words for container commands ("CLIENT SETNAME"). */
    static String commandName(List<byte[]> args) {
        if (args == null || args.isEmpty()) {
            return "?";
        }
        String name = ascii(args.get(0)).toUpperCase(Locale.ROOT);
        if (TWO_WORD.contains(name) && args.size() > 1) {
            name = name + " " + ascii(args.get(1)).toUpperCase(Locale.ROOT);
        }
        return name.length() > 64 ? name.substring(0, 64) : name;
    }

    static boolean housekeeping(List<byte[]> args) {
        return args != null && !args.isEmpty() && HOUSEKEEPING.contains(ascii(args.get(0)).toUpperCase(Locale.ROOT));
    }

    /**
     * AUTH and HELLO … AUTH credentials replaced by a placeholder (FR-007, research R8) - before anything leaves the
     * dispatcher, whatever the settings. Returns the arguments unchanged when nothing needs hiding.
     */
    static List<byte[]> scrubbed(List<byte[]> args) {
        if (args == null || args.isEmpty()) {
            return args;
        }
        String name = ascii(args.get(0)).toUpperCase(Locale.ROOT);
        byte[] hidden = CREDENTIALS.getBytes(StandardCharsets.UTF_8);
        if ("AUTH".equals(name)) {
            List<byte[]> out = new ArrayList<>(args.size());
            out.add(args.get(0));
            for (int i = 1; i < args.size(); i++) {
                out.add(hidden);
            }
            return out;
        }
        if ("HELLO".equals(name)) {
            List<byte[]> out = new ArrayList<>(args);
            for (int i = 1; i < out.size(); i++) {
                if ("AUTH".equalsIgnoreCase(ascii(out.get(i)))) {
                    for (int j = i + 1; j < Math.min(i + 3, out.size()); j++) {
                        out.set(j, hidden);
                    }
                }
            }
            return out;
        }
        return args;
    }

    /** The key arguments of a command (its name excluded from the indexes below). */
    static List<byte[]> keys(List<byte[]> args) {
        if (args == null || args.size() < 2) {
            return Collections.emptyList();
        }
        String name = ascii(args.get(0)).toUpperCase(Locale.ROOT);
        List<byte[]> rest = args.subList(1, args.size());
        if (NO_KEY.contains(name)) {
            return Collections.emptyList();
        }
        if (ALL_KEYS.contains(name)) {
            return rest;
        }
        if ("MSET".equals(name) || "MSETNX".equals(name)) {
            List<byte[]> out = new ArrayList<>();
            for (int i = 0; i < rest.size(); i += 2) {
                out.add(rest.get(i));
            }
            return out;
        }
        if (TWO_KEYS.contains(name)) {
            return rest.subList(0, Math.min(2, rest.size()));
        }
        if (KEYS_THEN_TIMEOUT.contains(name)) {
            return rest.subList(0, Math.max(0, rest.size() - 1));
        }
        if (NUMKEYS.contains(name)) {
            if (rest.size() < 2) {
                return Collections.emptyList();
            }
            try {
                int n = Integer.parseInt(ascii(rest.get(1)));
                return rest.subList(2, Math.min(rest.size(), 2 + Math.max(0, n)));
            } catch (NumberFormatException e) {
                return Collections.emptyList();
            }
        }
        return rest.subList(0, 1);
    }

    /** A key with its variable segments (all digits, hex/uuid of 8+, a call-id-like token) as {@code *}. */
    public static String pattern(String key) {
        if (key == null) {
            return null;
        }
        StringBuilder out = new StringBuilder(key.length());
        int start = 0;
        for (int i = 0; i <= key.length(); i++) {
            if (i == key.length() || key.charAt(i) == ':') {
                String segment = key.substring(start, i);
                out.append(variable(segment) ? "*" : segment);
                if (i < key.length()) {
                    out.append(':');
                }
                start = i + 1;
            }
        }
        return out.toString();
    }

    private static boolean variable(String s) {
        if (s.isEmpty()) {
            return false;
        }
        boolean digits = true;
        boolean hex = s.length() >= 8;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            digits &= c >= '0' && c <= '9';
            hex &= (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F') || c == '-';
        }
        return digits || hex;
    }

    /**
     * Command + first key's pattern + argument shape ({@code k} key, {@code n} number, an upper-case option word as itself,
     * {@code blob} anything else) - stable across calls for the same code, the matching key of a later replay (FR-051).
     */
    static String fingerprint(String command, List<byte[]> args, List<byte[]> keys) {
        StringBuilder out = new StringBuilder(command);
        if (!keys.isEmpty()) {
            out.append(' ').append(pattern(text(keys.get(0))));
        }
        out.append(" [");
        int skipName = command.indexOf(' ') > 0 ? 2 : 1;
        Set<byte[]> keySet = java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<byte[], Boolean>());
        keySet.addAll(keys);
        for (int i = skipName; i < args.size(); i++) {
            if (i > skipName) {
                out.append(',');
            }
            byte[] a = args.get(i);
            if (keySet.contains(a)) {
                out.append('k');
            } else if (numeric(a)) {
                out.append('n');
            } else if (word(a)) {
                out.append(ascii(a).toUpperCase(Locale.ROOT));
            } else {
                out.append("blob");
            }
            if (out.length() > 400) {
                out.append('…');
                break;
            }
        }
        return out.append(']').toString();
    }

    private static boolean numeric(byte[] a) {
        if (a.length == 0 || a.length > 24) {
            return false;
        }
        for (int i = 0; i < a.length; i++) {
            byte c = a[i];
            if (!((c >= '0' && c <= '9') || (i == 0 && c == '-') || c == '.')) {
                return false;
            }
        }
        return true;
    }

    private static boolean word(byte[] a) {
        if (a.length == 0 || a.length > 12) {
            return false;
        }
        for (byte c : a) {
            if (!((c >= 'A' && c <= 'Z') || c == '_')) { // an upper-case option (EX, NX, WITHSCORES); lower case is data
                return false;
            }
        }
        return true;
    }

    /** UTF-8 when the bytes are valid UTF-8 without control characters, otherwise with {@code \xNN} escapes. */
    public static String text(byte[] b) {
        if (b == null) {
            return null;
        }
        try {
            String s = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(b)).toString();
            boolean clean = true;
            for (int i = 0; i < s.length() && clean; i++) {
                clean = s.charAt(i) >= 0x20 || s.charAt(i) == '\t';
            }
            if (clean) {
                return s;
            }
        } catch (CharacterCodingException e) {
            // escaped below
        }
        StringBuilder out = new StringBuilder(b.length * 2);
        for (byte x : b) {
            int c = x & 0xff;
            if (c >= 0x20 && c < 0x7f && c != '\\') {
                out.append((char) c);
            } else {
                out.append(String.format("\\x%02x", c));
            }
        }
        return out.toString();
    }

    static String ascii(byte[] b) {
        return b == null ? "" : new String(b, StandardCharsets.ISO_8859_1);
    }

    private static void writeAscii(ByteArrayOutputStream out, String s) {
        byte[] b = s.getBytes(StandardCharsets.US_ASCII);
        out.write(b, 0, b.length);
    }
}
