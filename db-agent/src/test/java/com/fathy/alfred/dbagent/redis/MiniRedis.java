package com.fathy.alfred.dbagent.redis;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * A small in-test Redis (specs/011-redis-capture, research R18): just enough of RESP 2 and 3 and of the ~30 commands
 * the agent's ITs use, so the real Lettuce, Jedis and Redisson clients can run against it without Docker. Every reply
 * it writes is kept ({@link #replies}) so a test can compare the agent's recorded bytes with what was really sent.
 */
public final class MiniRedis implements Closeable {

    private final ServerSocket server;
    private final Map<String, Object> data = new ConcurrentHashMap<>();
    private final Map<String, Long> expiries = new ConcurrentHashMap<>();
    private final Map<String, String> scripts = new ConcurrentHashMap<>();
    /** Every command received, upper-case name first (to see what the agent sent itself). */
    public final List<List<String>> commands = new CopyOnWriteArrayList<>();
    /** Every reply written, in order, as bytes. */
    public final List<byte[]> replies = new CopyOnWriteArrayList<>();
    private volatile boolean running = true;
    private final List<Socket> clients = new CopyOnWriteArrayList<>();
    /** Milliseconds to wait before answering BLPOP. */
    public volatile long blpopDelayMillis = 300;

    public MiniRedis() throws IOException {
        server = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
        Thread t = new Thread(this::accept, "mini-redis");
        t.setDaemon(true);
        t.start();
    }

    public int port() {
        return server.getLocalPort();
    }

    public String uri() {
        return "redis://127.0.0.1:" + port();
    }

    public void reset() {
        data.clear();
        expiries.clear();
        scripts.clear();
        commands.clear();
        replies.clear();
    }

    public List<String> commandNames() {
        List<String> out = new ArrayList<>();
        for (List<String> c : commands) {
            out.add(c.get(0));
        }
        return out;
    }

    @Override
    public void close() throws IOException {
        running = false;
        server.close();
        for (Socket s : clients) {
            s.close();
        }
    }

    private void accept() {
        while (running) {
            try {
                Socket s = server.accept();
                clients.add(s);
                Thread t = new Thread(() -> serve(s), "mini-redis-conn");
                t.setDaemon(true);
                t.start();
            } catch (IOException e) {
                return;
            }
        }
    }

    private void serve(Socket socket) {
        Session session = new Session();
        try (Socket s = socket; InputStream raw = new BufferedInputStream(s.getInputStream()); OutputStream out = s.getOutputStream()) {
            while (running) {
                List<byte[]> args = readCommand(raw);
                if (args == null) {
                    return;
                }
                List<String> text = new ArrayList<>();
                for (byte[] a : args) {
                    text.add(new String(a, StandardCharsets.UTF_8));
                }
                text.set(0, text.get(0).toUpperCase(Locale.ROOT));
                commands.add(text);
                byte[] reply = handle(session, text, args);
                if (reply != null) {
                    replies.add(reply);
                    synchronized (out) {
                        out.write(reply);
                        out.flush();
                    }
                }
            }
        } catch (IOException e) {
            // client went away
        }
    }

    private static List<byte[]> readCommand(InputStream in) throws IOException {
        int first = in.read();
        if (first < 0) {
            return null;
        }
        if (first != '*') {
            throw new IOException("inline commands are not supported");
        }
        int n = Integer.parseInt(line(in));
        List<byte[]> args = new ArrayList<>(n);
        for (int i = 0; i < n; i++) {
            if (in.read() != '$') {
                throw new IOException("bulk expected");
            }
            int len = Integer.parseInt(line(in));
            byte[] b = new byte[len];
            int read = 0;
            while (read < len) {
                int r = in.read(b, read, len - read);
                if (r < 0) {
                    throw new IOException("eof");
                }
                read += r;
            }
            in.read();
            in.read();
            args.add(b);
        }
        return args;
    }

    private static String line(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = in.read()) != '\r') {
            if (c < 0) {
                throw new IOException("eof");
            }
            sb.append((char) c);
        }
        in.read();
        return sb.toString();
    }

    static final class Session {
        int resp = 2;
        List<List<String>> queued;
        List<List<byte[]>> queuedRaw;
    }

    // ------------------------------------------------------------------ commands

    private byte[] handle(Session session, List<String> c, List<byte[]> raw) {
        String name = c.get(0);
        if (session.queued != null && !name.equals("EXEC") && !name.equals("DISCARD") && !name.equals("MULTI")) {
            session.queued.add(c);
            session.queuedRaw.add(raw);
            return simple("QUEUED");
        }
        switch (name) {
            case "MULTI":
                session.queued = new ArrayList<>();
                session.queuedRaw = new ArrayList<>();
                return simple("OK");
            case "EXEC": {
                if (session.queued == null) {
                    return error("ERR EXEC without MULTI");
                }
                List<List<String>> q = session.queued;
                List<List<byte[]>> qr = session.queuedRaw;
                session.queued = null;
                session.queuedRaw = null;
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                ascii(out, "*" + q.size() + "\r\n");
                for (int i = 0; i < q.size(); i++) {
                    byte[] r = handle(session, q.get(i), qr.get(i));
                    out.write(r, 0, r.length);
                }
                return out.toByteArray();
            }
            case "DISCARD":
                session.queued = null;
                session.queuedRaw = null;
                return simple("OK");
            case "HELLO": {
                if (c.size() > 1) {
                    session.resp = Integer.parseInt(c.get(1));
                }
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("server", "redis");
                m.put("version", "7.2.0");
                m.put("proto", (long) session.resp);
                m.put("id", 1L);
                m.put("mode", "standalone");
                m.put("role", "master");
                m.put("modules", Collections.emptyList());
                return encode(session, m);
            }
            case "PING":
                return simple("PONG");
            case "AUTH":
            case "SELECT":
            case "READONLY":
            case "FLUSHDB":
                if (name.equals("FLUSHDB")) {
                    data.clear();
                }
                return simple("OK");
            case "CLIENT":
                if (c.size() > 1 && c.get(1).equalsIgnoreCase("ID")) {
                    return integer(1);
                }
                return simple("OK");
            case "COMMAND":
            case "INFO":
                return bulk(new byte[0]);
            case "GET": {
                Object v = live(c.get(1));
                return v == null ? nil(session) : bulk((byte[]) v);
            }
            case "SET": {
                boolean nx = false;
                long px = -1;
                for (int i = 3; i < c.size(); i++) {
                    String o = c.get(i).toUpperCase(Locale.ROOT);
                    if (o.equals("NX")) {
                        nx = true;
                    } else if (o.equals("EX")) {
                        px = Long.parseLong(c.get(++i)) * 1000;
                    } else if (o.equals("PX")) {
                        px = Long.parseLong(c.get(++i));
                    }
                }
                if (nx && live(c.get(1)) != null) {
                    return nil(session);
                }
                data.put(c.get(1), raw.get(2));
                expire(c.get(1), px);
                return simple("OK");
            }
            case "SETEX":
                data.put(c.get(1), raw.get(3));
                expire(c.get(1), Long.parseLong(c.get(2)) * 1000);
                return simple("OK");
            case "MSET":
                for (int i = 1; i + 1 < c.size(); i += 2) {
                    data.put(c.get(i), raw.get(i + 1));
                    expiries.remove(c.get(i));
                }
                return simple("OK");
            case "MGET": {
                List<Object> out = new ArrayList<>();
                for (int i = 1; i < c.size(); i++) {
                    out.add(live(c.get(i)));
                }
                return encode(session, out);
            }
            case "DEL": {
                int n = 0;
                for (int i = 1; i < c.size(); i++) {
                    if (data.remove(c.get(i)) != null) {
                        n++;
                    }
                }
                return integer(n);
            }
            case "INCR": {
                Object v = live(c.get(1));
                long n = v == null ? 1 : Long.parseLong(new String((byte[]) v, StandardCharsets.UTF_8)) + 1;
                data.put(c.get(1), String.valueOf(n).getBytes(StandardCharsets.UTF_8));
                return integer(n);
            }
            case "EXPIRE":
                if (live(c.get(1)) == null) {
                    return integer(0);
                }
                expire(c.get(1), Long.parseLong(c.get(2)) * 1000);
                return integer(1);
            case "PTTL": {
                if (live(c.get(1)) == null) {
                    return integer(-2);
                }
                Long at = expiries.get(c.get(1));
                return integer(at == null ? -1 : Math.max(0, at - System.currentTimeMillis()));
            }
            case "TTL": {
                if (live(c.get(1)) == null) {
                    return integer(-2);
                }
                Long at = expiries.get(c.get(1));
                return integer(at == null ? -1 : Math.max(0, (at - System.currentTimeMillis()) / 1000));
            }
            case "TYPE": {
                Object v = live(c.get(1));
                return simple(v == null ? "none" : v instanceof byte[] ? "string" : v instanceof Map ? "hash" : "list");
            }
            case "HSET": {
                @SuppressWarnings("unchecked")
                Map<String, byte[]> h = (Map<String, byte[]>) data.computeIfAbsent(c.get(1), k -> new LinkedHashMap<String, byte[]>());
                int added = 0;
                for (int i = 2; i + 1 < c.size(); i += 2) {
                    if (h.put(c.get(i), raw.get(i + 1)) == null) {
                        added++;
                    }
                }
                return integer(added);
            }
            case "HGETALL": {
                Object v = live(c.get(1));
                @SuppressWarnings("unchecked")
                Map<String, byte[]> h = v instanceof Map ? (Map<String, byte[]>) v : Collections.<String, byte[]>emptyMap();
                return encode(session, h);
            }
            case "RPUSH": {
                @SuppressWarnings("unchecked")
                List<byte[]> l = (List<byte[]>) data.computeIfAbsent(c.get(1), k -> new CopyOnWriteArrayList<byte[]>());
                for (int i = 2; i < c.size(); i++) {
                    l.add(raw.get(i));
                }
                return integer(l.size());
            }
            case "LRANGE": {
                Object v = live(c.get(1));
                return encode(session, v instanceof List ? v : Collections.emptyList());
            }
            case "BLPOP": {
                try {
                    Thread.sleep(blpopDelayMillis);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                Object v = live(c.get(1));
                if (v instanceof List && !((List<?>) v).isEmpty()) {
                    Object first = ((List<?>) v).remove(0);
                    List<Object> out = new ArrayList<>();
                    out.add(c.get(1).getBytes(StandardCharsets.UTF_8));
                    out.add(first);
                    return encode(session, out);
                }
                return session.resp == 3 ? "_\r\n".getBytes(StandardCharsets.US_ASCII) : "*-1\r\n".getBytes(StandardCharsets.US_ASCII);
            }
            case "SMEMBERS":
                return encode(session, Collections.emptyList());
            case "PUBLISH":
                return integer(2);
            case "KEYS": {
                List<Object> out = new ArrayList<>();
                for (String k : data.keySet()) {
                    out.add(k.getBytes(StandardCharsets.UTF_8));
                }
                return encode(session, out);
            }
            case "SCRIPT":
                if (c.size() > 2 && c.get(1).equalsIgnoreCase("LOAD")) {
                    String sha = Integer.toHexString(c.get(2).hashCode());
                    scripts.put(sha, c.get(2));
                    return bulk(sha.getBytes(StandardCharsets.UTF_8));
                }
                return simple("OK");
            case "EVALSHA":
                if (!scripts.containsKey(c.get(1))) {
                    return error("NOSCRIPT No matching script. Please use EVAL.");
                }
                return integer(1);
            case "EVAL":
                return integer(1);
            case "DOUBLE":
                // test-only: a RESP3 double / set / map reply
                return session.resp == 3 ? ",3.5\r\n".getBytes(StandardCharsets.US_ASCII) : bulk("3.5".getBytes(StandardCharsets.US_ASCII));
            default:
                return error("ERR unknown command '" + name + "'");
        }
    }

    private Object live(String key) {
        Long at = expiries.get(key);
        if (at != null && at < System.currentTimeMillis()) {
            data.remove(key);
            expiries.remove(key);
        }
        return data.get(key);
    }

    private void expire(String key, long px) {
        if (px > 0) {
            expiries.put(key, System.currentTimeMillis() + px);
        } else {
            expiries.remove(key);
        }
    }

    // ------------------------------------------------------------------ encoding

    private static byte[] simple(String s) {
        return ("+" + s + "\r\n").getBytes(StandardCharsets.UTF_8);
    }

    private static byte[] error(String s) {
        return ("-" + s + "\r\n").getBytes(StandardCharsets.UTF_8);
    }

    private static byte[] integer(long n) {
        return (":" + n + "\r\n").getBytes(StandardCharsets.US_ASCII);
    }

    private static byte[] nil(Session session) {
        return (session.resp == 3 ? "_\r\n" : "$-1\r\n").getBytes(StandardCharsets.US_ASCII);
    }

    private static byte[] bulk(byte[] v) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ascii(out, "$" + v.length + "\r\n");
        out.write(v, 0, v.length);
        ascii(out, "\r\n");
        return out.toByteArray();
    }

    private static byte[] encode(Session session, Object o) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        encode(session, o, out);
        return out.toByteArray();
    }

    private static void encode(Session session, Object o, ByteArrayOutputStream out) {
        if (o == null) {
            byte[] n = nil(session);
            out.write(n, 0, n.length);
        } else if (o instanceof byte[]) {
            byte[] b = bulk((byte[]) o);
            out.write(b, 0, b.length);
        } else if (o instanceof String) {
            byte[] b = bulk(((String) o).getBytes(StandardCharsets.UTF_8));
            out.write(b, 0, b.length);
        } else if (o instanceof Long) {
            byte[] b = integer((Long) o);
            out.write(b, 0, b.length);
        } else if (o instanceof Map) {
            Map<?, ?> m = (Map<?, ?>) o;
            ascii(out, (session.resp == 3 ? "%" + m.size() : "*" + m.size() * 2) + "\r\n");
            for (Map.Entry<?, ?> e : m.entrySet()) {
                encode(session, e.getKey(), out);
                encode(session, e.getValue(), out);
            }
        } else if (o instanceof List) {
            List<?> l = (List<?>) o;
            ascii(out, "*" + l.size() + "\r\n");
            for (Object e : l) {
                encode(session, e, out);
            }
        }
    }

    private static void ascii(ByteArrayOutputStream out, String s) {
        byte[] b = s.getBytes(StandardCharsets.US_ASCII);
        out.write(b, 0, b.length);
    }
}
