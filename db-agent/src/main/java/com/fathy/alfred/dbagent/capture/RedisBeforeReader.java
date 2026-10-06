package com.fathy.alfred.dbagent.capture;

import com.fathy.alfred.dbagent.AgentLog;
import com.fathy.alfred.dbagent.transport.AgentSettings;

import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;

/**
 * "Value before a write" (specs/011-redis-capture FR-024, research R7) - opt-in per project, the agent's one own Redis
 * work, the counterpart of the database before-image read. Just before a write command of a captured call is sent, it
 * reads what the key holds now - {@code TYPE}, then the type's full read, then {@code PTTL} - on the same client
 * through the client's public API, and leaves the answer for the command about to be recorded on this thread.
 *
 * <p>Never inside MULTI, a pipeline, a subscriber connection or on a client's event-loop thread: a read there would
 * join the application's transaction or batch and change what it gets (or wait on the thread that must answer it).
 * Those writes are recorded with the reason instead. Runs under the dispatcher's agent-work guard, so its own commands
 * are never recorded as the call's.
 */
final class RedisBeforeReader {

    /** Write commands with the key(s) they change (research R7). */
    private static final Set<String> WRITES = new HashSet<>(Arrays.asList(
            "SET", "SETNX", "SETEX", "PSETEX", "GETSET", "GETDEL", "GETEX", "APPEND", "SETRANGE", "INCR", "INCRBY", "INCRBYFLOAT",
            "DECR", "DECRBY", "MSET", "MSETNX", "HSET", "HSETNX", "HMSET", "HDEL", "HINCRBY", "HINCRBYFLOAT", "LPUSH", "RPUSH",
            "LPUSHX", "RPUSHX", "LPOP", "RPOP", "LSET", "LREM", "LTRIM", "LINSERT", "SADD", "SREM", "SPOP", "ZADD", "ZREM",
            "ZINCRBY", "ZPOPMIN", "ZPOPMAX", "DEL", "UNLINK", "EXPIRE", "PEXPIRE", "EXPIREAT", "PEXPIREAT", "PERSIST", "RENAME",
            "RENAMENX", "EVAL", "EVALSHA", "XADD", "XDEL", "XTRIM", "SETBIT", "PFADD"));
    private static final Set<String> TTL_ONLY = new HashSet<>(Arrays.asList("EXPIRE", "PEXPIRE", "EXPIREAT", "PEXPIREAT", "PERSIST"));
    /** At most this many keys are read for one multi-key write. */
    static final int MAX_KEYS = 8;
    static final long WAIT_MILLIS = 1_000;

    private final RedisCatcher catcher;
    private final AgentSettings settings;
    /** The before value for the next command recorded on this thread. */
    private final ThreadLocal<Before> next = new ThreadLocal<>();

    RedisBeforeReader(RedisCatcher catcher, AgentSettings settings) {
        this.catcher = catcher;
        this.settings = settings;
        catcher.beforeSource = this;
    }

    /** What a key held: RESP bytes (an array when several keys were read) and/or the reason nothing was read. */
    static final class Before {
        final byte[] bytes;
        final String note;

        Before(byte[] bytes, String note) {
            this.bytes = bytes;
            this.note = note;
        }
    }

    /** Hands the answer to the command being registered now (called once per recorded command). */
    Before take() {
        Before b = next.get();
        next.remove();
        return b;
    }

    private boolean wanted(String command) {
        if (!settings.redisBeforeImage() || command == null) {
            return false;
        }
        CallContext context = ContextPropagation.current();
        return context != null && context.redis && WRITES.contains(command);
    }

    private static boolean onEventLoop() {
        for (Class<?> c = Thread.currentThread().getClass(); c != null; c = c.getSuperclass()) {
            if (c.getName().equals("io.netty.util.concurrent.FastThreadLocalThread")) {
                return true;
            }
        }
        return false;
    }

    private String refusal(RedisCatcher.Conn conn, boolean pipelining) {
        if (conn != null && conn.tx != null) {
            return "not read (in a transaction)";
        }
        if (pipelining || (conn != null && conn.autoFlushOff)) {
            return "not read (in a pipeline)";
        }
        if (conn != null && conn.subscriber) {
            return "not read (subscriber connection)";
        }
        if (onEventLoop()) {
            return "not read (client event-loop thread)";
        }
        return null;
    }

    // ------------------------------------------------------------------ Jedis

    void beforeJedis(Object connection, Object command, Object args) {
        try {
            List<byte[]> all = catcher.jedisArgsOf(command, args);
            String name = all == null || all.isEmpty() ? null : RespFrame.ascii(all.get(0)).toUpperCase(Locale.ROOT);
            if (!wanted(name) || "MULTI".equals(name)) {
                return;
            }
            String no = refusal(catcher.connOf(connection), catcher.jedisWaiting(connection));
            if (no != null) {
                next.set(new Before(null, no));
                return;
            }
            List<byte[]> keys = RespFrame.keys(all);
            next.set(read(keys, TTL_ONLY.contains(name), (cmd, key) -> jedisRun(connection, cmd, key)));
        } catch (Throwable t) {
            AgentLog.failure("redis before-read", t);
            next.set(new Before(null, "not read (" + t.getClass().getSimpleName() + ")"));
        }
    }

    /** Connection.executeCommand(CommandArguments) (Jedis 4/5), or sendCommand + getOne (Jedis 3). Raw protocol objects. */
    private Object jedisRun(Object connection, String cmd, byte[] key) throws Exception {
        ClassLoader loader = connection.getClass().getClassLoader();
        Class<?> protocolCommand = loader.loadClass("redis.clients.jedis.Protocol$Command");
        Object type = Enum.valueOf(protocolCommand.asSubclass(Enum.class), cmd.split(" ")[0]);
        List<byte[]> extra = extraArgs(cmd);
        try {
            Class<?> argsClass = loader.loadClass("redis.clients.jedis.CommandArguments");
            Object arguments = argsClass.getConstructor(loader.loadClass("redis.clients.jedis.commands.ProtocolCommand")).newInstance(type);
            Method add = argsClass.getMethod("add", byte[].class);
            add.invoke(arguments, (Object) key);
            for (byte[] e : extra) {
                add.invoke(arguments, (Object) e);
            }
            return connection.getClass().getMethod("executeCommand", argsClass).invoke(connection, arguments);
        } catch (ClassNotFoundException jedis3) {
            List<byte[]> params = new ArrayList<>();
            params.add(key);
            params.addAll(extra);
            Method send = connection.getClass().getMethod("sendCommand", loader.loadClass("redis.clients.jedis.commands.ProtocolCommand"), byte[][].class);
            send.invoke(connection, type, params.toArray(new byte[0][]));
            return connection.getClass().getMethod("getOne").invoke(connection);
        }
    }

    // ------------------------------------------------------------------ Lettuce

    void beforeLettuce(String client, Object command, Object endpoint) {
        if (!"lettuce".equals(client) || command instanceof Collection || endpoint == null) {
            return;
        }
        try {
            Object type = catcher.invoke(command, "getType");
            String name = type == null ? null : String.valueOf(catcher.invoke(type, "name")).toUpperCase(Locale.ROOT);
            if (!wanted(name)) {
                return;
            }
            String no = refusal(catcher.connOf(endpoint), false);
            if (no != null) {
                next.set(new Before(null, no));
                return;
            }
            Object args = catcher.invoke(command, "getArgs");
            Object first = catcher.invoke(args, "getFirstEncodedKey");
            if (!(first instanceof ByteBuffer)) {
                return;
            }
            ByteBuffer buf = ((ByteBuffer) first).duplicate();
            byte[] key = new byte[buf.remaining()];
            buf.get(key);
            next.set(read(Collections.singletonList(key), TTL_ONLY.contains(name), (cmd, k) -> lettuceRun(command, endpoint, cmd, k)));
        } catch (Throwable t) {
            AgentLog.failure("redis before-read", t);
            next.set(new Before(null, "not read (" + t.getClass().getSimpleName() + ")"));
        }
    }

    /**
     * new AsyncCommand(new Command(CommandType.X, new ArrayOutput(ByteArrayCodec.INSTANCE), args)) written to the same
     * endpoint; its raw reply is captured by the decode hook (registered with {@link RedisCatcher#expectOwn}).
     */
    private Object lettuceRun(Object appCommand, Object endpoint, String cmd, byte[] key) throws Exception {
        ClassLoader loader = appCommand.getClass().getClassLoader();
        Class<?> codecClass = loader.loadClass("io.lettuce.core.codec.ByteArrayCodec");
        Object codec = codecClass.getField("INSTANCE").get(null);
        Class<?> redisCodec = loader.loadClass("io.lettuce.core.codec.RedisCodec");
        Class<?> commandType = loader.loadClass("io.lettuce.core.protocol.CommandType");
        Class<?> argsClass = loader.loadClass("io.lettuce.core.protocol.CommandArgs");
        Object args = argsClass.getConstructor(redisCodec).newInstance(codec);
        argsClass.getMethod("addKey", Object.class).invoke(args, (Object) key);
        for (byte[] e : extraArgs(cmd)) {
            argsClass.getMethod("add", byte[].class).invoke(args, (Object) e);
        }
        Object output = loader.loadClass("io.lettuce.core.output.ArrayOutput").getConstructor(redisCodec).newInstance(codec);
        Class<?> keyword = loader.loadClass("io.lettuce.core.protocol.ProtocolKeyword");
        Class<?> commandOutput = loader.loadClass("io.lettuce.core.output.CommandOutput");
        Constructor<?> ctor = loader.loadClass("io.lettuce.core.protocol.Command").getConstructor(keyword, commandOutput, argsClass);
        Object inner = ctor.newInstance(Enum.valueOf(commandType.asSubclass(Enum.class), cmd.split(" ")[0]), output, args);
        Class<?> redisCommand = loader.loadClass("io.lettuce.core.protocol.RedisCommand");
        Object async = loader.loadClass("io.lettuce.core.protocol.AsyncCommand").getConstructor(redisCommand).newInstance(inner);
        RedisCatcher.BeforeRead read = catcher.expectOwn("lettuce", async);
        endpoint.getClass().getMethod("write", redisCommand).invoke(endpoint, async);
        ((java.util.concurrent.Future<?>) async).get(WAIT_MILLIS, TimeUnit.MILLISECONDS);
        return read != null && read.bytes != null ? new Raw(read.bytes) : catcher.invoke(output, "get");
    }

    // ------------------------------------------------------------------ Redisson

    /** At RedisExecutor.sendCommand: the executor knows its command and parameters; the connection is its argument. */
    void beforeRedisson(Object executor, Object connection) {
        try {
            Object redisCommand = catcher.field(executor, "command");
            Object name = catcher.invoke(redisCommand, "getName");
            String cmd = name == null ? null : String.valueOf(name).toUpperCase(Locale.ROOT);
            if (!wanted(cmd) || connection == null) {
                return;
            }
            String no = refusal(null, false);
            if (no != null) {
                next.set(new Before(null, no));
                return;
            }
            Object[] params = (Object[]) catcher.field(executor, "params");
            if (params == null || params.length == 0) {
                return;
            }
            Object keyParam = params[0];
            byte[] key = keyParam instanceof byte[] ? (byte[]) keyParam : String.valueOf(keyParam).getBytes(StandardCharsets.UTF_8);
            next.set(read(Collections.singletonList(key), TTL_ONLY.contains(cmd), (c, k) -> redissonRun(connection, c, k)));
        } catch (Throwable t) {
            AgentLog.failure("redis before-read", t);
            next.set(new Before(null, "not read (" + t.getClass().getSimpleName() + ")"));
        }
    }

    /** RedisConnection.sync(ByteArrayCodec, RedisCommands.X, key, …) - decoded objects, encoded back to RESP. */
    private Object redissonRun(Object connection, String cmd, byte[] key) throws Exception {
        ClassLoader loader = connection.getClass().getClassLoader();
        Object codec = loader.loadClass("org.redisson.client.codec.ByteArrayCodec").getField("INSTANCE").get(null);
        String field;
        switch (cmd) {
            case "LRANGE": field = "LRANGE"; break;
            case "ZRANGE WITHSCORES": field = "ZRANGE_ENTRY"; break;
            case "XRANGE": field = "XRANGE"; break;
            default: field = cmd;
        }
        Object command = loader.loadClass("org.redisson.client.protocol.RedisCommands").getField(field).get(null);
        List<Object> params = new ArrayList<>();
        params.add(key);
        for (byte[] e : extraArgs(cmd)) {
            params.add(new String(e, StandardCharsets.US_ASCII));
        }
        if (cmd.equals("ZRANGE WITHSCORES")) {
            params.add("WITHSCORES");
        }
        Method sync = null;
        for (Method m : connection.getClass().getMethods()) {
            if (m.getName().equals("sync") && m.getParameterCount() == 3 && m.getParameterTypes()[2] == Object[].class) {
                sync = m;
            }
        }
        if (sync == null) {
            throw new IllegalStateException("RedisConnection.sync not found");
        }
        return sync.invoke(connection, codec, command, params.toArray());
    }

    // ------------------------------------------------------------------ the reads

    interface Runner {
        Object run(String command, byte[] key) throws Exception;
    }

    /** A captured raw reply (Lettuce) - kept as it is, not re-encoded. */
    static final class Raw {
        final byte[] bytes;

        Raw(byte[] bytes) {
            this.bytes = bytes;
        }
    }

    private Before read(List<byte[]> keys, boolean ttlOnly, Runner runner) throws Exception {
        if (keys.isEmpty()) {
            return null;
        }
        List<byte[]> values = new ArrayList<>();
        List<String> notes = new ArrayList<>();
        for (int i = 0; i < keys.size() && i < MAX_KEYS; i++) {
            byte[] key = keys.get(i);
            byte[] ttl = resp(runner.run("PTTL", key));
            if (ttlOnly) {
                values.add(ttl);
                notes.add(ttlText(ttl));
                continue;
            }
            String type = text(runner.run("TYPE", key));
            String read = readCommandFor(type);
            if (read == null) {
                values.add("$-1\r\n".getBytes(StandardCharsets.US_ASCII));
                notes.add(type == null || "none".equals(type) ? "(nil) - new key" : "type " + normalType(type) + " not read");
                continue;
            }
            values.add(resp(runner.run(read, key)));
            notes.add("type " + normalType(type) + " · " + ttlText(ttl));
        }
        String note = keys.size() == 1 ? notes.get(0) : keys.size() + " keys" + (keys.size() > MAX_KEYS ? " (first " + MAX_KEYS + " read)" : "")
                + ": " + String.join("; ", notes);
        if (values.size() == 1) {
            return new Before(values.get(0), note);
        }
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] head = ("*" + values.size() + "\r\n").getBytes(StandardCharsets.US_ASCII);
        out.write(head, 0, head.length);
        for (byte[] v : values) {
            out.write(v, 0, v.length);
        }
        return new Before(out.toByteArray(), note);
    }

    private static String readCommandFor(String type) {
        if (type == null) {
            return null;
        }
        switch (normalType(type)) {
            case "string": return "GET";
            case "hash": return "HGETALL";
            case "list": return "LRANGE";
            case "set": return "SMEMBERS";
            case "zset": return "ZRANGE WITHSCORES";
            case "stream": return "XRANGE";
            default: return null;
        }
    }

    /** Redis's TYPE answer - Redisson converts it to its RType enum (OBJECT, MAP, …), mapped back here. */
    static String normalType(String type) {
        switch (type) {
            case "OBJECT": return "string";
            case "MAP": return "hash";
            case "LIST": return "list";
            case "SET": return "set";
            case "ZSET": return "zset";
            default: return type.toLowerCase(Locale.ROOT);
        }
    }

    /** Arguments after the key for the reads that need them. */
    private static List<byte[]> extraArgs(String cmd) {
        switch (cmd) {
            case "LRANGE": return Arrays.asList(b("0"), b("-1"));
            case "ZRANGE WITHSCORES": return Arrays.asList(b("0"), b("-1"));
            case "XRANGE": return Arrays.asList(b("-"), b("+"));
            default: return Collections.emptyList();
        }
    }

    private static byte[] b(String s) {
        return s.getBytes(StandardCharsets.US_ASCII);
    }

    private static String ttlText(byte[] pttl) {
        String s = text(pttl);
        try {
            long ms = Long.parseLong(s == null ? "" : s.replace(":", "").trim());
            return ms == -2 ? "no key" : ms == -1 ? "no ttl" : "ttl " + (ms / 1000) + " s left";
        } catch (NumberFormatException e) {
            return "ttl ?";
        }
    }

    private static String text(Object reply) {
        byte[] r = reply instanceof Raw ? ((Raw) reply).bytes : null;
        if (r != null) {
            String s = new String(r, StandardCharsets.UTF_8).trim();
            return s.isEmpty() ? s : s.substring(1).replace("\r\n", "").trim();
        }
        if (reply instanceof List && !((List<?>) reply).isEmpty()) {
            return text(((List<?>) reply).get(0));
        }
        if (reply instanceof byte[]) {
            return new String((byte[]) reply, StandardCharsets.UTF_8);
        }
        if (reply instanceof ByteBuffer) {
            ByteBuffer b = ((ByteBuffer) reply).duplicate();
            byte[] out = new byte[b.remaining()];
            b.get(out);
            return new String(out, StandardCharsets.UTF_8);
        }
        return reply == null ? null : String.valueOf(reply);
    }

    private static String text(byte[] resp) {
        return text(new Raw(resp));
    }

    /** RESP bytes of a reply: kept as captured, or encoded from the client's objects (status replies as bulk). */
    static byte[] resp(Object reply) {
        if (reply instanceof Raw) {
            return ((Raw) reply).bytes;
        }
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        encode(reply, out);
        return out.toByteArray();
    }

    private static void encode(Object o, java.io.ByteArrayOutputStream out) {
        if (o == null) {
            ascii(out, "$-1\r\n");
        } else if (o instanceof byte[] || o instanceof ByteBuffer || o instanceof CharSequence || o instanceof Double || o instanceof Float) {
            byte[] v;
            if (o instanceof byte[]) {
                v = (byte[]) o;
            } else if (o instanceof ByteBuffer) {
                ByteBuffer b = ((ByteBuffer) o).duplicate();
                v = new byte[b.remaining()];
                b.get(v);
            } else {
                v = String.valueOf(o).getBytes(StandardCharsets.UTF_8);
            }
            ascii(out, "$" + v.length + "\r\n");
            out.write(v, 0, v.length);
            ascii(out, "\r\n");
        } else if (o instanceof Number) {
            ascii(out, ":" + ((Number) o).longValue() + "\r\n");
        } else if (o instanceof Boolean) {
            ascii(out, ":" + ((Boolean) o ? 1 : 0) + "\r\n");
        } else if (o instanceof Map) {
            Map<?, ?> m = (Map<?, ?>) o;
            ascii(out, "*" + m.size() * 2 + "\r\n");
            for (Map.Entry<?, ?> e : m.entrySet()) {
                encode(e.getKey(), out);
                encode(e.getValue(), out);
            }
        } else if (o instanceof Collection) {
            Collection<?> c = (Collection<?>) o;
            ascii(out, "*" + c.size() + "\r\n");
            for (Object e : c) {
                encode(e, out);
            }
        } else if (o instanceof Throwable) {
            ascii(out, "-" + String.valueOf(((Throwable) o).getMessage()).replace("\r\n", " ") + "\r\n");
        } else {
            encode(String.valueOf(o), out);
        }
    }

    private static void ascii(java.io.ByteArrayOutputStream out, String s) {
        byte[] b = s.getBytes(StandardCharsets.US_ASCII);
        out.write(b, 0, b.length);
    }
}
