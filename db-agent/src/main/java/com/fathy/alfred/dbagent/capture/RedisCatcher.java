package com.fathy.alfred.dbagent.capture;

import com.fathy.alfred.dbagent.AgentLog;
import com.fathy.alfred.dbagent.redis.CaptureOnlyRedisInterceptor;
import com.fathy.alfred.dbagent.redis.RedisInterceptor;
import com.fathy.alfred.dbagent.transport.AgentSettings;
import com.fathy.alfred.dbagent.transport.RedisChunkRecord;
import com.fathy.alfred.dbagent.transport.RedisCommandRecord;
import com.fathy.alfred.dbagent.transport.StatementSink;

import java.io.ByteArrayOutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Deque;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Turns what the Redis client hooks see into {@link RedisCommandRecord}s of their call (specs/011-redis-capture,
 * research R1-R8). Every client is reached reflectively - the agent depends on none.
 *
 * <p>A command is attributed where it is SENT, on the application's thread: its call, its place in the call's shared
 * sequence, the code line and the Spring Cache origin are taken there and kept in a {@link Pending} found again by
 * identity when the bytes go out and when the reply comes back - on a Netty event-loop thread for Lettuce and
 * Redisson (keyed by the command's output / the CommandData), in order on the same connection for Jedis (a FIFO per
 * connection). The request and reply are copied from the client's own buffers, so they are exactly the bytes sent and
 * received. Never throws into the application.
 */
public final class RedisCatcher {

    /** A command still without its reply after this long is sent as failed - its connection was lost or it never ends. */
    static final long STALE_NANOS = 30_000_000_000L;
    private static final DateTimeFormatter AT = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

    private final StatementSink sink;
    private final AgentSettings settings;
    private final String agentId;
    private final RedisInterceptor interceptor = new CaptureOnlyRedisInterceptor();
    private final AtomicLong sids = new AtomicLong();
    private final AtomicLong groups = new AtomicLong();

    /** Lettuce: by the command's CommandOutput (shared by every wrapper of the command). Redisson: by the CommandData. */
    private final WeakIdentityMap<Pending> byCommand = new WeakIdentityMap<>();
    /** Jedis: commands sent and not yet answered, in order, per Connection. */
    private final WeakIdentityMap<Deque<Pending>> jedisQueues = new WeakIdentityMap<>();
    /** Per client connection/endpoint/channel: its short id, server, database, open transaction, pipelining. */
    private final WeakIdentityMap<Conn> conns = new WeakIdentityMap<>();
    /** Redisson: the call each RedisExecutor was created in. */
    private final WeakIdentityMap<CallContext> executors = new WeakIdentityMap<>();
    /** Every command waiting for its reply - for the stale sweep. */
    private final ConcurrentLinkedQueue<Pending> open = new ConcurrentLinkedQueue<>();

    private final ThreadLocal<CallContext> executorContext = new ThreadLocal<>();
    private final ThreadLocal<int[]> jedisSendDepth = ThreadLocal.withInitial(() -> new int[1]);
    private final ThreadLocal<int[]> redissonDecodeDepth = ThreadLocal.withInitial(() -> new int[1]);
    private final ThreadLocal<JedisRead> jedisRead = new ThreadLocal<>();
    private final ThreadLocal<Deque<Origin>> origins = ThreadLocal.withInitial(ArrayDeque::new);
    private final ThreadLocal<long[]> poolWait = ThreadLocal.withInitial(() -> new long[]{-1});
    private final Map<String, Object> methods = new ConcurrentHashMap<>();
    /** Value-before-a-write reads (opt-in) - set by RedisBeforeReader. */
    RedisBeforeReader beforeSource;
    private static final Object NONE = new Object();
    private static final Object NESTED = new Object();

    RedisCatcher(StatementSink sink, AgentSettings settings, String agentId) {
        this.sink = sink;
        this.settings = settings;
        this.agentId = agentId;
    }

    /** One command between its send and its reply. */
    static final class Pending {
        final CallContext context;
        final int seq;
        final long startNanos = System.nanoTime();
        final String at = AT.format(Instant.now());
        final String client;
        final String thread = Thread.currentThread().getName();
        String code;
        List<String> callers;
        Origin origin;
        long poolWaitMicros = -1;
        String name;
        List<byte[]> args;
        byte[] request;
        final ByteArrayOutputStream reply = new ByteArrayOutputStream();
        boolean replied;
        String error;
        Conn conn;
        String groupKind;
        String groupId;
        int groupIndex;
        Group group;
        byte[] before;
        String beforeType;
        String beforeNote;
        Deque<Pending> jedisQueue;
        String version;
        /** EXEC / DISCARD: its reply completes the transaction. */
        boolean closesGroup;
        /** Set for the agent's own before-write reads (research R7): their reply goes here, never to the sink. */
        BeforeRead beforeFor;

        Pending(CallContext context, int seq, String client) {
            this.context = context;
            this.seq = seq;
            this.client = client;
        }
    }

    /**
     * A transaction (MULTI … EXEC) or pipeline. Its members' records wait ({@code parked}) until it closes, so each is
     * sent with the group's final size - a member's reply can come before the group's last command was even sent.
     */
    static final class Group {
        final String kind;
        final String id;
        final long openedNanos = System.nanoTime();
        final List<Pending> members = new ArrayList<>();
        final List<RedisCommandRecord> parked = new ArrayList<>();
        int size;
        /** No more members will join (EXEC sent, pipeline flushed, collection written, Jedis queue drained). */
        boolean membersFinal;

        Group(String kind, String id) {
            this.kind = kind;
            this.id = id;
        }
    }

    /** Groups not closed yet - swept with the stale commands (an application that never sends EXEC). */
    private final ConcurrentLinkedQueue<Group> openGroups = new ConcurrentLinkedQueue<>();

    static final class Conn {
        final String id;
        String server;
        int db;
        Group tx;
        Group pipeline;
        boolean autoFlushOff;
        boolean subscriber;

        Conn(String id) {
            this.id = id;
        }
    }

    /** The Spring Cache operation a command is sent for (research R5). */
    static final class Origin {
        final String cache;
        final String operation;
        final String method;

        Origin(String cache, String operation, String method) {
            this.cache = cache;
            this.operation = operation;
            this.method = method;
        }
    }

    /** A reply being read off a Jedis RedisInputStream. */
    static final class JedisRead {
        final Object stream;
        final Deque<Pending> queue;
        final ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        int start;

        JedisRead(Object stream, Deque<Pending> queue, int start) {
            this.stream = stream;
            this.queue = queue;
            this.start = start;
        }
    }

    /** A Lettuce/Redisson encode or decode in progress. */
    static final class BufferSpan {
        final Object buffer;
        final int start;
        final Object msg;
        final Object channelContext;
        final Pending pending;
        final String client;

        BufferSpan(String client, Object buffer, int start, Object msg, Object channelContext, Pending pending) {
            this.client = client;
            this.buffer = buffer;
            this.start = start;
            this.msg = msg;
            this.channelContext = channelContext;
            this.pending = pending;
        }
    }

    /** Collects the reply of one of the agent's own reads. */
    static final class BeforeRead {
        volatile byte[] bytes;
        volatile boolean done;
    }

    // ================================================================== sending side

    /** Once per client per JVM: its hooks run - so "Redis 0" can be told apart from "hooks never ran". */
    private final java.util.Set<String> hooksSeen = java.util.Collections.newSetFromMap(new java.util.concurrent.ConcurrentHashMap<>());

    void hookSeen(String client) {
        if (hooksSeen.add(client)) {
            AgentLog.info("redis: " + client + " hooks are active");
        }
    }

    private CallContext callContext() {
        CallContext context = ContextPropagation.current();
        if (context == null) {
            context = executorContext.get();
        }
        return context != null && context.redis ? context : null;
    }

    /** A command exists on the sending side (Lettuce endpoint write, Redisson CommandData) - see Bridge. */
    void commandCreated(String client, Object command, Object endpoint) {
        hookSeen(client);
        if (command instanceof Collection) {
            Collection<?> all = (Collection<?>) command;
            Conn conn = endpoint == null ? null : conn(endpoint);
            Group batch = all.size() > 1 && conn != null && conn.tx == null ? newGroup("pipeline") : null;
            for (Object one : all) {
                Pending p = register(client, one, conn);
                if (p != null && batch != null && p.group == null) {
                    join(p, batch);
                }
            }
            if (batch != null) {
                synchronized (batch) {
                    batch.membersFinal = true;
                }
                closeIfAnswered(batch);
            }
            return;
        }
        register(client, command, endpoint == null ? null : conn(endpoint));
    }

    private Pending register(String client, Object command, Conn conn) {
        CallContext context = callContext();
        if (context == null) {
            return null;
        }
        Object key = "lettuce".equals(client) ? invoke(command, "getOutput") : command;
        if (key == null || byCommand.get(key) != null) {
            return null;
        }
        String name = nameOf(client, command);
        if (name != null && !settings.redisHousekeeping() && RespFrame.housekeeping(Collections.singletonList(name.getBytes(StandardCharsets.ISO_8859_1)))) {
            return null;
        }
        Pending p = new Pending(context, context.nextSeq(), client);
        p.name = name;
        p.version = versionOf(command);
        fillWhere(p);
        p.conn = conn;
        if (conn != null) {
            group(p, conn);
        }
        byCommand.put(key, p);
        open.add(p);
        interceptor.onSend(p);
        return p;
    }

    private void fillWhere(Pending p) {
        RedisBeforeReader.Before before = beforeSource == null ? null : beforeSource.take();
        if (before != null) {
            p.before = before.bytes;
            p.beforeNote = before.note;
        }
        CodeLocation.Where where = CodeLocation.find(settings.callerFrames(), settings.passThrough());
        p.code = where.location;
        p.callers = where.callers;
        Deque<Origin> stack = origins.get();
        p.origin = originOf(stack);
        long[] wait = poolWait.get();
        if (wait[0] >= 0) {
            p.poolWaitMicros = wait[0];
            wait[0] = -1;
        }
    }

    /** The innermost RedisCache operation with the method of the nearest CacheAspectSupport.execute around it. */
    private static Origin originOf(Deque<Origin> stack) {
        if (stack.isEmpty()) {
            return null;
        }
        String cache = null;
        String operation = null;
        String method = null;
        for (Origin o : stack) { // innermost first
            if (cache == null && o.cache != null) {
                cache = o.cache;
                operation = o.operation;
            }
            if (method == null && o.method != null) {
                method = o.method;
            }
        }
        return cache == null && method == null ? null : new Origin(cache, operation, method);
    }

    /** MULTI opens a transaction on the connection until EXEC/DISCARD; with auto-flush off every command joins the pipeline. */
    private void group(Pending p, Conn conn) {
        String name = p.name == null ? "" : p.name;
        synchronized (conn) {
            if ("MULTI".equals(name)) {
                conn.tx = newGroup("tx");
            }
            if (conn.tx != null) {
                join(p, conn.tx);
                if ("EXEC".equals(name) || "DISCARD".equals(name)) {
                    p.closesGroup = true;
                    conn.tx = null;
                }
                return;
            }
            if (conn.autoFlushOff) {
                if (conn.pipeline == null) {
                    conn.pipeline = newGroup("pipeline");
                }
                join(p, conn.pipeline);
            }
        }
    }

    private static void join(Pending p, Group g) {
        synchronized (g) {
            p.group = g;
            p.groupKind = g.kind;
            p.groupId = g.id;
            p.groupIndex = g.members.size();
            g.members.add(p);
        }
    }

    private String groupId() {
        return "g" + groups.incrementAndGet();
    }

    private Group newGroup(String kind) {
        Group g = new Group(kind, groupId());
        openGroups.add(g);
        return g;
    }

    /** The group is complete: every parked member goes out now with the final size; later members go straight out. */
    private void close(Group g) {
        List<RedisCommandRecord> out;
        synchronized (g) {
            if (g.size > 0) {
                return;
            }
            g.size = Math.max(1, g.members.size());
            out = new ArrayList<>(g.parked);
            g.parked.clear();
        }
        openGroups.remove(g);
        for (RedisCommandRecord r : out) {
            r.groupSize = g.size;
            send(r);
        }
    }

    void autoFlush(Object endpoint, boolean on) {
        Conn conn = conn(endpoint);
        synchronized (conn) {
            conn.autoFlushOff = !on;
            if (on) {
                closePipeline(conn);
            }
        }
    }

    void flush(Object endpoint) {
        Conn conn = conn(endpoint);
        synchronized (conn) {
            closePipeline(conn);
        }
    }

    /** No more commands will join: the group closes once its last member was answered (see complete). */
    private void closePipeline(Conn conn) {
        Group g = conn.pipeline;
        conn.pipeline = null;
        if (g != null) {
            synchronized (g) {
                g.membersFinal = true;
            }
            closeIfAnswered(g);
        }
    }

    private void closeIfAnswered(Group g) {
        boolean all;
        synchronized (g) {
            all = g.membersFinal && g.parked.size() >= g.members.size();
        }
        if (all) {
            close(g);
        }
    }

    // ------------------------------------------------------------------ encoding (Lettuce, Redisson)

    Object encodeEnter(String client, Object channelContext, Object msg, Object buffer) {
        if (!anyPending(client, msg)) {
            return null; // nothing of ours in it: no byte is copied
        }
        Integer start = intCall(buffer, "writerIndex");
        return start == null ? null : new BufferSpan(client, buffer, start, msg, channelContext, null);
    }

    private boolean anyPending(String client, Object msg) {
        if (msg instanceof Collection) {
            for (Object one : (Collection<?>) msg) {
                if (pendingOf(client, one) != null) {
                    return true;
                }
            }
            return false;
        }
        if ("redisson".equals(client) && msg != null && msg.getClass().getName().endsWith("CommandsData")) {
            Object commands = invoke(msg, "getCommands");
            return commands instanceof Collection && anyPending(client, commands);
        }
        return pendingOf(client, msg) != null;
    }

    private Pending pendingOf(String client, Object command) {
        if (command == null) {
            return null;
        }
        Object key = "lettuce".equals(client) ? invoke(command, "getOutput") : command;
        return key == null ? null : byCommand.get(key);
    }

    void encodeExit(Object token) {
        BufferSpan span = (BufferSpan) token;
        Integer end = intCall(span.buffer, "writerIndex");
        if (end == null || end <= span.start) {
            return;
        }
        byte[] written = copy(span.buffer, span.start, end);
        List<Object> commands = new ArrayList<>();
        if (span.msg instanceof Collection) {
            commands.addAll((Collection<?>) span.msg);
        } else if ("redisson".equals(span.client) && span.msg.getClass().getName().endsWith("CommandsData")) {
            Object inner = invoke(span.msg, "getCommands");
            if (inner instanceof Collection) {
                commands.addAll((Collection<?>) inner);
            }
        } else {
            commands.add(span.msg);
        }
        Conn conn = span.channelContext == null ? null : channelConn(span.channelContext);
        int at = 0;
        for (Object command : commands) {
            int frameEnd = RespFrame.frameEnd(written, at, written.length);
            if (frameEnd < 0) {
                return;
            }
            Pending p = pendingOf(span.client, command);
            if (p != null && p.request == null) {
                setRequest(p, RespFrame.args(written, at, frameEnd));
                if (p.conn == null) {
                    p.conn = conn;
                    if (conn != null && p.group == null) {
                        group(p, conn);
                    }
                } else if (conn != null && p.conn.server == null) {
                    p.conn.server = conn.server;
                }
            }
            at = frameEnd;
        }
    }

    private void setRequest(Pending p, List<byte[]> args) {
        if (args == null) {
            return;
        }
        List<byte[]> safe = RespFrame.scrubbed(args);
        p.args = safe;
        p.request = RespFrame.request(safe);
        p.name = RespFrame.commandName(safe);
    }

    // ------------------------------------------------------------------ decoding (Lettuce, Redisson)

    Object decodeEnter(String client, Object command, Object buffer) {
        if ("redisson".equals(client)) {
            int depth = ++redissonDecodeDepth.get()[0];
            if (depth > 1) {
                return NESTED;
            }
        }
        Pending p = pendingOf(client, command);
        if (p == null) {
            return "redisson".equals(client) ? NONE : null;
        }
        Integer start = intCall(buffer, "readerIndex");
        if (start == null) {
            return "redisson".equals(client) ? NONE : null;
        }
        return new BufferSpan(client, buffer, start, command, null, p);
    }

    void decodeExit(Object token, boolean done, Throwable thrown) {
        if (token == NESTED || token == NONE) {
            redissonDecodeDepth.get()[0]--;
            return;
        }
        BufferSpan span = (BufferSpan) token;
        if ("redisson".equals(span.client)) {
            redissonDecodeDepth.get()[0]--;
        }
        Integer end = intCall(span.buffer, "readerIndex");
        Pending p = span.pending;
        if (end != null && end > span.start) {
            byte[] part = copy(span.buffer, span.start, end);
            synchronized (p) {
                p.reply.write(part, 0, part.length);
            }
        }
        if (thrown != null && p.error == null) {
            p.error = thrown.getClass().getSimpleName() + (thrown.getMessage() == null ? "" : ": " + thrown.getMessage());
        }
        if (done || thrown != null) {
            Object key = "lettuce".equals(span.client) ? invoke(span.msg, "getOutput") : span.msg;
            if (key != null) {
                byCommand.remove(key);
            }
            complete(p, true);
        }
    }

    // ------------------------------------------------------------------ Jedis

    Object jedisSend(Object connection, Object command, Object args) {
        int depth = ++jedisSendDepth.get()[0];
        if (depth > 1) {
            return NESTED;
        }
        try {
            hookSeen("jedis");
            CallContext context = callContext();
            if (context == null) {
                CallContext any = ContextPropagation.current();
                if (any != null) {
                    AgentLog.warn("redis: Jedis commands ran during a call not marked redis=1 (⬢ off for its project?) - not recorded");
                }
                return NONE;
            }
            List<byte[]> all = jedisArgs(command, args);
            if (all == null || all.isEmpty()) {
                AgentLog.warn("redis: could not read a Jedis command (" + (command == null ? "null" : command.getClass().getName())
                        + ", args " + (args == null ? "null" : args.getClass().getName()) + ") - not recorded");
                return NONE;
            }
            if (!settings.redisHousekeeping() && RespFrame.housekeeping(all)) {
                return NONE;
            }
            Pending p = new Pending(context, context.nextSeq(), "jedis");
            setRequest(p, all);
            fillWhere(p);
            Conn conn = conn(connection);
            if (conn.server == null) {
                conn.server = jedisServer(connection);
            }
            p.conn = conn;
            Deque<Pending> queue = jedisQueue(connection);
            synchronized (queue) {
                group(p, conn);
                // sent while an earlier command still waits for its reply: the application is pipelining
                if (p.group == null && !queue.isEmpty()) {
                    Pending previous = queue.peekLast();
                    Group g = previous.group != null && "pipeline".equals(previous.groupKind) ? previous.group : null;
                    if (g == null) {
                        g = newGroup("pipeline");
                        join(previous, g);
                    }
                    join(p, g);
                }
                queue.addLast(p);
                p.jedisQueue = queue;
            }
            p.version = versionOf(command);
            open.add(p);
            interceptor.onSend(p);
            return p;
        } catch (Throwable t) {
            AgentLog.failure("redis send", t);
            return NONE;
        }
    }

    void jedisSendExit(Object token, Throwable thrown) {
        jedisSendDepth.get()[0]--;
        if (token instanceof Pending && thrown != null) {
            Pending p = (Pending) token;
            p.error = thrown.getClass().getSimpleName() + (thrown.getMessage() == null ? "" : ": " + thrown.getMessage());
            removeFromQueues(p);
            complete(p, true);
        }
    }

    /** A failed send never gets a reply: out of its connection's queue, so the next reply is matched to the next command. */
    private void removeFromQueues(Pending p) {
        open.remove(p);
        if (p.jedisQueue != null) {
            synchronized (p.jedisQueue) {
                p.jedisQueue.remove(p);
            }
        }
    }

    Object jedisReadEnter(Object connection) {
        Deque<Pending> queue = jedisQueues.get(connection);
        if (queue == null) {
            return null;
        }
        synchronized (queue) {
            if (queue.isEmpty()) {
                return null;
            }
        }
        Object stream = field(connection, "inputStream");
        if (stream == null) {
            return null;
        }
        Integer count = intField(stream, "count");
        if (count == null) {
            return null;
        }
        JedisRead read = new JedisRead(stream, queue, count);
        jedisRead.set(read);
        return read;
    }

    void jedisFill(Object stream) {
        JedisRead read = jedisRead.get();
        if (read == null || read.stream != stream) {
            return;
        }
        Integer count = intField(stream, "count");
        Integer limit = intField(stream, "limit");
        byte[] buf = (byte[]) field(stream, "buf");
        if (count == null || limit == null || buf == null || count < limit) {
            return; // ensureFill will not refill: nothing is lost
        }
        if (limit > read.start) {
            read.bytes.write(buf, read.start, limit - read.start);
        }
        read.start = 0; // the refilled buffer is read from its beginning
    }

    void jedisReply(Object token, Object result, Throwable thrown) {
        JedisRead read = (JedisRead) token;
        jedisRead.remove();
        Integer count = intField(read.stream, "count");
        byte[] buf = (byte[]) field(read.stream, "buf");
        if (count != null && buf != null && count > read.start) {
            read.bytes.write(buf, read.start, count - read.start);
        }
        Pending p;
        boolean drained;
        synchronized (read.queue) {
            p = read.queue.pollFirst();
            drained = read.queue.isEmpty();
        }
        if (p == null) {
            return;
        }
        if (drained && p.group != null && "pipeline".equals(p.groupKind)) {
            synchronized (p.group) {
                p.group.membersFinal = true; // every command sent before was answered: the pipeline is over
            }
        }
        byte[] bytes = read.bytes.toByteArray();
        p.reply.write(bytes, 0, bytes.length);
        if (thrown != null && (bytes.length == 0 || bytes[0] != '-')) {
            // a connection failure, not an error reply (an error reply raises too, after its bytes were read)
            p.error = thrown.getClass().getSimpleName() + (thrown.getMessage() == null ? "" : ": " + thrown.getMessage());
        }
        complete(p, true);
    }

    private Deque<Pending> jedisQueue(Object connection) {
        Deque<Pending> queue = jedisQueues.get(connection);
        if (queue == null) {
            synchronized (jedisQueues) {
                queue = jedisQueues.get(connection);
                if (queue == null) {
                    queue = new ArrayDeque<>();
                    jedisQueues.put(connection, queue);
                }
            }
        }
        return queue;
    }

    List<byte[]> jedisArgsOf(Object command, Object args) {
        return jedisArgs(command, args);
    }

    /** True while a Jedis connection has commands sent and not yet answered - the application is pipelining. */
    boolean jedisWaiting(Object connection) {
        Deque<Pending> queue = jedisQueues.get(connection);
        if (queue == null) {
            return false;
        }
        synchronized (queue) {
            return !queue.isEmpty();
        }
    }

    /** The arguments of a Jedis send: CommandArguments (Jedis 4/5) or a ProtocolCommand with byte[]/String/Rawable args. */
    private List<byte[]> jedisArgs(Object command, Object args) {
        if (command == null) {
            return null;
        }
        List<byte[]> out = new ArrayList<>();
        if (command instanceof Iterable && command.getClass().getName().endsWith("CommandArguments")) {
            for (Object rawable : (Iterable<?>) command) {
                Object raw = rawOf(rawable);
                if (raw instanceof byte[]) {
                    out.add((byte[]) raw);
                }
            }
            return out;
        }
        Object raw = rawOf(command);
        if (!(raw instanceof byte[])) {
            return null;
        }
        out.add((byte[]) raw);
        if (args instanceof byte[][]) {
            Collections.addAll(out, (byte[][]) args);
        } else if (args instanceof String[]) {
            for (String s : (String[]) args) {
                out.add(s == null ? new byte[0] : s.getBytes(StandardCharsets.UTF_8));
            }
        } else if (args != null) {
            Object r = rawOf(args);
            if (r instanceof byte[]) {
                out.add((byte[]) r);
            }
        }
        return out;
    }

    /** A command's or argument's bytes: {@code getRaw()} (Jedis 3+), or the public {@code raw} field Jedis 2.x's
     *  {@code Protocol.Command} and {@code Protocol.Keyword} have instead of the method. */
    private Object rawOf(Object target) {
        Object raw = invoke(target, "getRaw");
        return raw instanceof byte[] ? raw : field(target, "raw");
    }

    private String jedisServer(Object connection) {
        Object socket = field(connection, "socket");
        if (socket instanceof java.net.Socket) {
            java.net.Socket s = (java.net.Socket) socket;
            if (s.getInetAddress() != null) {
                return s.getInetAddress().getHostName() + ":" + s.getPort();
            }
        }
        return null;
    }

    // ------------------------------------------------------------------ Redisson executor

    void executorCreated(Object executor) {
        CallContext context = ContextPropagation.current();
        if (context != null && context.redis) {
            executors.put(executor, context);
        }
    }

    Object executorSendEnter(Object executor) {
        CallContext context = executors.get(executor);
        if (context == null || ContextPropagation.current() != null) {
            return null;
        }
        executorContext.set(context);
        return context;
    }

    void executorSendExit(Object token) {
        executorContext.remove();
    }

    // ------------------------------------------------------------------ Spring Cache, pools

    Object originEnter(String kind, Object self, Object[] args) {
        if (callContext() == null) {
            return null;
        }
        Origin origin;
        if ("aspect".equals(kind)) {
            origin = new Origin(null, null, methodText(args));
        } else {
            Object name = invoke(self, "getName");
            origin = new Origin(name == null ? "?" : String.valueOf(name), operationOf(kind), null);
        }
        origins.get().push(origin);
        return origin;
    }

    void originExit(Object token) {
        Deque<Origin> stack = origins.get();
        if (!stack.isEmpty()) {
            stack.pop();
        }
    }

    static String operationOf(String method) {
        switch (method) {
            case "lookup":
            case "get":
            case "retrieve":
                return "@Cacheable";
            case "put":
            case "putIfAbsent":
                return "cache put";
            case "evict":
            case "evictIfPresent":
                return "evict";
            default:
                return "clear";
        }
    }

    /** {@code FareRuleService.load("EK")} from CacheAspectSupport.execute's Method and arguments. */
    static String methodText(Object[] args) {
        if (args == null || args.length < 4 || !(args[2] instanceof Method)) {
            return null;
        }
        Method m = (Method) args[2];
        StringBuilder out = new StringBuilder(m.getDeclaringClass().getSimpleName()).append('.').append(m.getName()).append('(');
        Object[] values = args[3] instanceof Object[] ? (Object[]) args[3] : new Object[0];
        for (int i = 0; i < values.length; i++) {
            if (i > 0) {
                out.append(", ");
            }
            Object v = values[i];
            String s = v == null ? "null" : v instanceof CharSequence ? "\"" + v + "\"" : v instanceof Number || v instanceof Boolean || v instanceof Enum ? String.valueOf(v)
                    : v.getClass().getSimpleName();
            out.append(s.length() > 60 ? s.substring(0, 57) + "…" : s);
        }
        return out.append(')').toString();
    }

    Object poolEnter(Object pool) {
        return callContext() == null ? null : new long[]{System.nanoTime()};
    }

    void poolExit(Object token, Object resource) {
        String type = resource == null ? "" : resource.getClass().getName();
        if (!(type.startsWith("io.lettuce.") || type.startsWith("redis.clients.") || type.startsWith("org.redisson."))) {
            return; // a pool of something else (a JDBC pool built on commons-pool2)
        }
        long started = ((long[]) token)[0];
        poolWait.get()[0] = Math.max(0, (System.nanoTime() - started) / 1000);
    }

    // ------------------------------------------------------------------ completion

    /** Commands without a reply after {@link #STALE_NANOS} are sent as failed (connection lost, never answered). */
    void flushStale(long now) {
        for (Group g : openGroups) {
            if (now - g.openedNanos > STALE_NANOS) {
                close(g);
            }
        }
        for (Iterator<Pending> it = open.iterator(); it.hasNext(); ) {
            Pending p = it.next();
            if (p.replied) {
                it.remove();
            } else if (now - p.startNanos > STALE_NANOS) {
                it.remove();
                if (p.error == null) {
                    p.error = "no reply (connection lost or still waiting after 30 s)";
                }
                complete(p, false);
            }
        }
    }

    private void complete(Pending p, boolean fromReply) {
        synchronized (p) {
            if (p.replied) {
                return;
            }
            p.replied = true;
        }
        if (p.beforeFor != null) {
            p.beforeFor.bytes = p.reply.toByteArray();
            p.beforeFor.done = true;
            return;
        }
        try {
            byte[] reply = p.reply.toByteArray();
            interceptor.onReply(p, reply);
            RedisCommandRecord r = record(p, reply, System.nanoTime());
            if ("SELECT".equals(r.command) && "SIMPLE".equals(r.replyType) && p.conn != null && p.args != null && p.args.size() > 1) {
                try {
                    p.conn.db = Integer.parseInt(RespFrame.ascii(p.args.get(1)));
                } catch (NumberFormatException ignored) {
                    // not a number: the server refused it anyway
                }
            }
            Group g = p.group;
            if (g == null) {
                send(r);
                return;
            }
            boolean parked = false;
            synchronized (g) {
                if (g.size == 0) {
                    g.parked.add(r);
                    parked = true;
                    if (p.closesGroup) {
                        g.membersFinal = true;
                    }
                } else {
                    r.groupSize = g.size;
                }
            }
            if (!parked) {
                send(r);
            } else {
                closeIfAnswered(g);
            }
        } catch (Throwable t) {
            AgentLog.failure("redis record", t);
        }
    }

    private RedisCommandRecord record(Pending p, byte[] reply, long now) {
        RedisCommandRecord r = new RedisCommandRecord();
        r.sid = agentId + "-r" + sids.incrementAndGet();
        r.callId = p.context.callId();
        r.runTag = p.context.runTag();
        r.seq = p.seq;
        r.at = p.at;
        r.micros = Math.max(0, (now - p.startNanos) / 1000);
        List<byte[]> args = p.args == null ? Collections.<byte[]>emptyList() : p.args;
        r.command = p.name != null ? p.name : RespFrame.commandName(args);
        List<byte[]> keys = RespFrame.keys(args);
        r.keysTotal = keys.size();
        List<String> keyText = new ArrayList<>(Math.min(keys.size(), RedisCommandRecord.MAX_KEYS));
        for (int i = 0; i < keys.size() && i < RedisCommandRecord.MAX_KEYS; i++) {
            String k = RespFrame.text(keys.get(i));
            keyText.add(k.length() > RedisCommandRecord.MAX_KEY_CHARS ? k.substring(0, RedisCommandRecord.MAX_KEY_CHARS - 1) + "…" : k);
        }
        r.keys = keyText;
        r.args = p.request;
        r.argsBytes = p.request == null ? 0 : p.request.length;
        r.reply = reply.length == 0 ? null : reply;
        r.replyBytes = reply.length;
        r.replyType = RespFrame.type(reply);
        r.resp = RespFrame.version(reply);
        String err = RespFrame.errorText(reply);
        r.error = err != null ? err : p.error;
        r.client = p.version == null ? p.client : p.client + " " + p.version;
        seen(p, r);
        if (p.conn != null) {
            r.connection = p.conn.id;
            r.server = p.conn.server;
            r.db = p.conn.db;
        }
        r.thread = p.thread;
        r.code = p.code;
        r.callers = p.callers;
        if (p.origin != null) {
            r.originCache = p.origin.cache;
            r.originOperation = p.origin.operation;
            r.originMethod = p.origin.method;
        }
        if (p.group != null) {
            r.groupKind = p.groupKind;
            r.groupId = p.groupId;
            r.groupIndex = p.groupIndex;
            synchronized (p.group) {
                r.groupSize = p.group.size > 0 ? p.group.size : p.group.members.size();
            }
        }
        r.poolWaitMicros = p.poolWaitMicros;
        r.before = p.before;
        r.beforeType = p.before == null ? null : RespFrame.type(p.before);
        r.beforeNote = p.beforeNote;
        r.beforeBytes = p.before == null ? 0 : p.before.length;
        r.fingerprint = RespFrame.fingerprint(r.command, args, keys);
        return r;
    }

    /** One record, or the record plus the parts of its bytes when they do not fit one (research R4). */
    private void send(RedisCommandRecord r) {
        long total = len(r.args) + len(r.reply) + len(r.before);
        if (total <= RedisChunkRecord.PART_BYTES) {
            sink.redis(r, Collections.<RedisChunkRecord>emptyList());
            return;
        }
        List<RedisChunkRecord> chunks = new ArrayList<>();
        chunk(r.sid, "args", r.args, chunks);
        chunk(r.sid, "reply", r.reply, chunks);
        chunk(r.sid, "before", r.before, chunks);
        r.args = null;
        r.reply = null;
        r.before = null;
        r.chunked = true;
        sink.redis(r, chunks);
    }

    private static void chunk(String sid, String which, byte[] bytes, List<RedisChunkRecord> out) {
        if (bytes == null || bytes.length == 0) {
            return;
        }
        int of = (bytes.length + RedisChunkRecord.PART_BYTES - 1) / RedisChunkRecord.PART_BYTES;
        for (int part = 0; part < of; part++) {
            int from = part * RedisChunkRecord.PART_BYTES;
            out.add(new RedisChunkRecord(sid, which, part, of, java.util.Arrays.copyOfRange(bytes, from, Math.min(bytes.length, from + RedisChunkRecord.PART_BYTES))));
        }
    }

    private static long len(byte[] b) {
        return b == null ? 0 : b.length;
    }

    /** The client library's version from its jar's manifest (Implementation-Version / Bundle-Version), cached per class. */
    private final Map<Class<?>, String> versions = new ConcurrentHashMap<>();

    private String versionOf(Object command) {
        if (command == null) {
            return null;
        }
        Class<?> type = command.getClass();
        String v = versions.get(type);
        if (v == null) {
            Package pkg = type.getPackage();
            v = pkg == null ? null : pkg.getImplementationVersion();
            if (v == null) {
                v = manifestVersion(type);
            }
            versions.put(type, v == null ? "" : v);
        }
        return v == null || v.isEmpty() ? null : v;
    }

    private static String manifestVersion(Class<?> type) {
        try {
            java.security.CodeSource source = type.getProtectionDomain().getCodeSource();
            if (source == null || source.getLocation() == null || !source.getLocation().getPath().endsWith(".jar")) {
                return null;
            }
            try (java.util.jar.JarFile jar = new java.util.jar.JarFile(new java.io.File(source.getLocation().toURI()))) {
                java.util.jar.Manifest manifest = jar.getManifest();
                if (manifest == null) {
                    return null;
                }
                String v = manifest.getMainAttributes().getValue("Implementation-Version");
                return v != null ? v : manifest.getMainAttributes().getValue("Bundle-Version");
            }
        } catch (Exception e) {
            return null;
        }
    }

    // ------------------------------------------------------------------ what the heartbeat reports (Settings: clients found)

    /** Per client name: version, connection ids, servers and databases seen; and Spring Cache names. Bounded sets. */
    private final Map<String, ClientSeen> clientsSeen = new ConcurrentHashMap<>();
    private final java.util.Set<String> springCaches = java.util.Collections.newSetFromMap(new ConcurrentHashMap<String, Boolean>());

    static final class ClientSeen {
        volatile String version;
        final java.util.Set<String> connections = java.util.Collections.newSetFromMap(new ConcurrentHashMap<String, Boolean>());
        final java.util.Set<String> servers = java.util.Collections.newSetFromMap(new ConcurrentHashMap<String, Boolean>());
        final java.util.Set<Integer> dbs = java.util.Collections.newSetFromMap(new ConcurrentHashMap<Integer, Boolean>());
    }

    private void seen(Pending p, RedisCommandRecord r) {
        ClientSeen c = clientsSeen.computeIfAbsent(p.client, k -> new ClientSeen());
        if (p.version != null) {
            c.version = p.version;
        }
        if (r.connection != null && c.connections.size() < 256) {
            c.connections.add(r.connection);
        }
        if (r.server != null && c.servers.size() < 32) {
            c.servers.add(r.server);
        }
        if (c.dbs.size() < 16) {
            c.dbs.add(r.db);
        }
        if (r.originCache != null && springCaches.size() < 256) {
            springCaches.add(r.originCache);
        }
    }

    /** {"clients":[{client, version, connections, servers, dbs}], "springCaches":[…]} for the heartbeat. */
    public Map<String, Object> seenForHeartbeat() {
        List<Object> clients = new ArrayList<>();
        for (Map.Entry<String, ClientSeen> e : clientsSeen.entrySet()) {
            Map<String, Object> m = new java.util.LinkedHashMap<>();
            m.put("client", e.getKey());
            m.put("version", e.getValue().version);
            m.put("connections", e.getValue().connections.size());
            m.put("servers", new ArrayList<>(e.getValue().servers));
            m.put("dbs", new ArrayList<>(e.getValue().dbs));
            clients.add(m);
        }
        Map<String, Object> out = new java.util.LinkedHashMap<>();
        out.put("clients", clients);
        out.put("springCaches", new ArrayList<>(springCaches));
        return out;
    }

    // ------------------------------------------------------------------ connections

    private Conn conn(Object key) {
        Conn conn = conns.get(key);
        if (conn == null) {
            synchronized (conns) {
                conn = conns.get(key);
                if (conn == null) {
                    conn = new Conn("conn-r-" + Integer.toHexString(System.identityHashCode(key) & 0xffff));
                    conns.put(key, conn);
                }
            }
        }
        return conn;
    }

    /** The connection of a Netty ChannelHandlerContext - its channel, with the server it is connected to. */
    private Conn channelConn(Object channelContext) {
        Object channel = invoke(channelContext, "channel");
        if (channel == null) {
            return null;
        }
        Conn conn = conn(channel);
        if (conn.server == null) {
            Object address = invoke(channel, "remoteAddress");
            if (address instanceof java.net.InetSocketAddress) {
                java.net.InetSocketAddress a = (java.net.InetSocketAddress) address;
                conn.server = a.getHostString() + ":" + a.getPort();
            }
        }
        return conn;
    }

    // ------------------------------------------------------------------ before-write reads (research R7)

    /** The connection state a before-read needs to decide whether it may run. */
    Conn connOf(Object key) {
        return conn(key);
    }

    /** Registers one of the agent's own reads so its reply is captured here (never sent as a command of the call). */
    BeforeRead expectOwn(String client, Object command) {
        Object key = "lettuce".equals(client) ? invoke(command, "getOutput") : command;
        if (key == null) {
            return null;
        }
        Pending p = new Pending(null, 0, client);
        p.beforeFor = new BeforeRead();
        byCommand.put(key, p);
        return p.beforeFor;
    }

    // ------------------------------------------------------------------ reflection helpers

    private String nameOf(String client, Object command) {
        Object type = "lettuce".equals(client) ? invoke(command, "getType") : invoke(command, "getCommand");
        if (type == null) {
            return null;
        }
        Object name = "lettuce".equals(client) ? invoke(type, "name") : invoke(type, "getName");
        if (name == null) {
            name = type.toString();
        }
        return String.valueOf(name).toUpperCase(Locale.ROOT);
    }

    private byte[] copy(Object buffer, int from, int to) {
        byte[] out = new byte[to - from];
        try {
            Method m = method(buffer.getClass(), "getBytes", int.class, byte[].class);
            if (m != null) {
                m.invoke(buffer, from, out);
            }
        } catch (Exception e) {
            AgentLog.failure("redis buffer copy", e);
        }
        return out;
    }

    private Integer intCall(Object target, String name) {
        Object v = invoke(target, name);
        return v instanceof Integer ? (Integer) v : null;
    }

    Object invoke(Object target, String name) {
        if (target == null) {
            return null;
        }
        try {
            Method m = method(target.getClass(), name);
            return m == null ? null : m.invoke(target);
        } catch (Exception e) {
            return null;
        }
    }

    private Method method(Class<?> type, String name, Class<?>... params) {
        // by class identity, not name: two deployments (or two Jedis versions) have same-named classes that differ
        String key = type.getName() + "@" + System.identityHashCode(type) + "#" + name + "/" + params.length;
        Object cached = methods.get(key);
        if (cached == NONE) {
            return null;
        }
        if (cached != null) {
            return (Method) cached;
        }
        Method found = null;
        for (Class<?> c = type; c != null && found == null; c = c.getSuperclass()) {
            try {
                found = c.getMethod(name, params);
            } catch (NoSuchMethodException e) {
                try {
                    found = c.getDeclaredMethod(name, params);
                } catch (NoSuchMethodException ignored) {
                    // keep looking up
                }
            }
        }
        if (found != null) {
            try {
                found.setAccessible(true);
            } catch (RuntimeException e) {
                found = null; // a module that will not open it
            }
        }
        methods.put(key, found == null ? NONE : found);
        return found;
    }

    Object field(Object target, String name) {
        if (target == null) {
            return null;
        }
        String key = target.getClass().getName() + "@" + System.identityHashCode(target.getClass()) + "." + name;
        Object cached = methods.get(key);
        if (cached == NONE) {
            return null;
        }
        try {
            Field f = (Field) cached;
            if (f == null) {
                for (Class<?> c = target.getClass(); c != null && f == null; c = c.getSuperclass()) {
                    try {
                        f = c.getDeclaredField(name);
                    } catch (NoSuchFieldException ignored) {
                        // keep looking up
                    }
                }
                if (f == null) {
                    methods.put(key, NONE);
                    return null;
                }
                f.setAccessible(true);
                methods.put(key, f);
            }
            return f.get(target);
        } catch (Exception e) {
            methods.put(key, NONE);
            return null;
        }
    }

    private Integer intField(Object target, String name) {
        Object v = field(target, name);
        return v instanceof Integer ? (Integer) v : null;
    }
}
