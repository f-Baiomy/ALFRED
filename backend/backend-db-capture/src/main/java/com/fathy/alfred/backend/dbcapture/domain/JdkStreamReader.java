package com.fathy.alfred.backend.dbcapture.domain;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;

/**
 * Reads a Java serialization stream as a structure - class names, field names and values - WITHOUT creating a single
 * object or loading a class (specs/011-redis-capture research R11, clarification Q4): a value written by
 * ObjectOutputStream is shown as it was stored, and no gadget in it can run. Common JDK types (strings, boxed numbers,
 * BigDecimal/BigInteger, Date, java.time, ArrayList/LinkedList, HashMap/LinkedHashMap/TreeMap, HashSet) are shown as
 * values; data a class wrote with its own writeObject that cannot be interpreted is shown as bytes and marks the
 * result partial. Bounded: depth 64, 200,000 nodes.
 */
public final class JdkStreamReader {

    static final int MAX_DEPTH = 64;
    static final int MAX_NODES = 200_000;

    private static final byte TC_NULL = 0x70, TC_REFERENCE = 0x71, TC_CLASSDESC = 0x72, TC_OBJECT = 0x73, TC_STRING = 0x74,
            TC_ARRAY = 0x75, TC_CLASS = 0x76, TC_BLOCKDATA = 0x77, TC_ENDBLOCKDATA = 0x78, TC_RESET = 0x79,
            TC_BLOCKDATALONG = 0x7A, TC_EXCEPTION = 0x7B, TC_LONGSTRING = 0x7C, TC_PROXYCLASSDESC = 0x7D, TC_ENUM = 0x7E;
    private static final int BASE_HANDLE = 0x7E0000;
    private static final byte SC_WRITE_METHOD = 0x01, SC_SERIALIZABLE = 0x02, SC_EXTERNALIZABLE = 0x04, SC_BLOCK_DATA = 0x08;

    /** The result: the text and whether any part could only be shown as bytes. */
    public record Result(String className, String text, boolean partial) {
    }

    public static boolean looksLike(byte[] b) {
        return b != null && b.length > 4 && (b[0] & 0xff) == 0xAC && (b[1] & 0xff) == 0xED && b[2] == 0 && b[3] == 5;
    }

    /** Null when the bytes are not a readable stream. */
    public static Result read(byte[] bytes) {
        if (!looksLike(bytes)) {
            return null;
        }
        try {
            JdkStreamReader r = new JdkStreamReader(bytes);
            r.pos = 4;
            List<Object> top = new ArrayList<>();
            while (r.pos < bytes.length && top.size() < 64) {
                top.add(r.content(0));
            }
            StringBuilder out = new StringBuilder();
            for (int i = 0; i < top.size(); i++) {
                if (i > 0) {
                    out.append('\n');
                }
                render(top.get(i), out, 0);
            }
            Object first = top.isEmpty() ? null : top.get(0);
            String cls = first instanceof Obj o ? o.cls : first instanceof Str ? "java.lang.String" : null;
            return new Result(cls, out.toString(), r.partial);
        } catch (RuntimeException e) {
            return null;
        }
    }

    // ------------------------------------------------------------------ the model

    /** A class description: name, flags, fields, super class. */
    static final class ClassDesc {
        String name;
        byte flags;
        List<String[]> fields = new ArrayList<>(); // {typecode, name, className}
        ClassDesc superDesc;
    }

    /** An object: its class, its field values per class in the hierarchy, and what writeObject wrote. */
    static final class Obj {
        String cls;
        final List<Object[]> fields = new ArrayList<>(); // {name, value}
        final List<Object> annotation = new ArrayList<>();
        Object shown; // a JDK type rendered as a value
    }

    record Str(String value) {
    }

    record Arr(String cls, List<Object> items, byte[] bytes) {
    }

    record EnumVal(String cls, String constant) {
    }

    record Block(byte[] data) {
    }

    record Raw(String note) {
    }

    private final byte[] b;
    private int pos;
    private int nodes;
    private boolean partial;
    private final List<Object> handles = new ArrayList<>();

    private JdkStreamReader(byte[] b) {
        this.b = b;
    }

    // ------------------------------------------------------------------ grammar

    private Object content(int depth) {
        if (depth > MAX_DEPTH || ++nodes > MAX_NODES) {
            partial = true;
            pos = b.length;
            return new Raw("… (too deep or too large to show)");
        }
        byte tc = u1();
        switch (tc) {
            case TC_NULL:
                return null;
            case TC_REFERENCE: {
                int h = s4() - BASE_HANDLE;
                Object ref = h >= 0 && h < handles.size() ? handles.get(h) : null;
                return ref instanceof ClassDesc cd ? new Raw("class " + cd.name) : ref;
            }
            case TC_STRING: {
                Str s = new Str(utf(u2()));
                handles.add(s);
                return s;
            }
            case TC_LONGSTRING: {
                Str s = new Str(utf((int) s8()));
                handles.add(s);
                return s;
            }
            case TC_OBJECT:
                return object(depth);
            case TC_ARRAY:
                return array(depth);
            case TC_ENUM: {
                ClassDesc cd = classDesc(depth);
                int slot = handles.size();
                handles.add(null);
                Object name = content(depth + 1);
                EnumVal e = new EnumVal(cd == null ? "?" : cd.name, name instanceof Str s ? s.value() : String.valueOf(name));
                handles.set(slot, e);
                return e;
            }
            case TC_CLASS: {
                ClassDesc cd = classDesc(depth);
                handles.add(cd);
                return new Raw("class " + (cd == null ? "?" : cd.name));
            }
            case TC_CLASSDESC:
            case TC_PROXYCLASSDESC:
                pos--;
                return new Raw("class " + nameOf(classDesc(depth)));
            case TC_BLOCKDATA:
                return new Block(bytes(u1() & 0xff));
            case TC_BLOCKDATALONG:
                return new Block(bytes(s4()));
            case TC_RESET:
                handles.clear();
                return content(depth);
            case TC_EXCEPTION:
                partial = true;
                return new Raw("exception while writing");
            default:
                throw new IllegalStateException("unknown token " + tc);
        }
    }

    private static String nameOf(ClassDesc cd) {
        return cd == null ? "?" : cd.name;
    }

    private ClassDesc classDesc(int depth) {
        byte tc = u1();
        if (tc == TC_NULL) {
            return null;
        }
        if (tc == TC_REFERENCE) {
            int h = s4() - BASE_HANDLE;
            Object ref = h >= 0 && h < handles.size() ? handles.get(h) : null;
            return ref instanceof ClassDesc cd ? cd : null;
        }
        ClassDesc cd = new ClassDesc();
        if (tc == TC_PROXYCLASSDESC) {
            handles.add(cd);
            int n = s4();
            StringBuilder names = new StringBuilder("Proxy(");
            for (int i = 0; i < n; i++) {
                names.append(i > 0 ? ", " : "").append(utf(u2()));
            }
            cd.name = names.append(')').toString();
            annotation(depth, null);
            cd.superDesc = classDesc(depth + 1);
            return cd;
        }
        if (tc != TC_CLASSDESC) {
            throw new IllegalStateException("class description expected");
        }
        cd.name = utf(u2());
        pos += 8; // serialVersionUID
        handles.add(cd);
        cd.flags = u1();
        int fields = u2();
        for (int i = 0; i < fields; i++) {
            char type = (char) u1();
            String name = utf(u2());
            String cls = null;
            if (type == 'L' || type == '[') {
                Object c = content(depth + 1);
                cls = c instanceof Str s ? s.value() : null;
            }
            cd.fields.add(new String[]{String.valueOf(type), name, cls});
        }
        annotation(depth, null);
        cd.superDesc = classDesc(depth + 1);
        return cd;
    }

    /** Contents up to TC_ENDBLOCKDATA - a class annotation or what writeObject wrote. */
    private void annotation(int depth, List<Object> into) {
        while (true) {
            if (pos >= b.length) {
                throw new IllegalStateException("eof in annotation");
            }
            if (b[pos] == TC_ENDBLOCKDATA) {
                pos++;
                return;
            }
            Object c = content(depth + 1);
            if (into != null) {
                into.add(c);
            }
        }
    }

    private Object object(int depth) {
        ClassDesc cd = classDesc(depth);
        Obj o = new Obj();
        o.cls = nameOf(cd);
        handles.add(o);
        List<ClassDesc> chain = new ArrayList<>();
        for (ClassDesc c = cd; c != null; c = c.superDesc) {
            chain.add(0, c);
        }
        for (ClassDesc c : chain) {
            if ((c.flags & SC_EXTERNALIZABLE) != 0) {
                if ((c.flags & SC_BLOCK_DATA) != 0) {
                    annotation(depth, o.annotation);
                } else {
                    partial = true;
                    pos = b.length; // protocol 1 externalizable: its length is unknowable
                }
                continue;
            }
            if ((c.flags & SC_SERIALIZABLE) != 0) {
                for (String[] f : c.fields) {
                    o.fields.add(new Object[]{f[1], value(f[0].charAt(0), depth)});
                }
                if ((c.flags & SC_WRITE_METHOD) != 0) {
                    annotation(depth, o.annotation);
                }
            }
        }
        o.shown = shown(o);
        if (o.shown == null && !o.annotation.isEmpty() && !knownWriteObject(o.cls)) {
            partial = true;
        }
        return o;
    }

    private Object value(char type, int depth) {
        return switch (type) {
            case 'B' -> (int) u1();
            case 'C' -> String.valueOf((char) u2());
            case 'D' -> Double.longBitsToDouble(s8());
            case 'F' -> Float.intBitsToFloat(s4());
            case 'I' -> s4();
            case 'J' -> s8();
            case 'S' -> (short) u2();
            case 'Z' -> u1() != 0;
            default -> content(depth + 1);
        };
    }

    private Object array(int depth) {
        ClassDesc cd = classDesc(depth);
        String cls = nameOf(cd);
        int slot = handles.size();
        handles.add(null);
        int n = s4();
        if (n < 0 || n > b.length) {
            throw new IllegalStateException("bad array length");
        }
        char component = cls.length() > 1 ? cls.charAt(1) : 'L';
        Arr arr;
        if (component == 'B') {
            arr = new Arr(cls, null, bytes(n));
        } else {
            List<Object> items = new ArrayList<>(Math.min(n, 10_000));
            for (int i = 0; i < n; i++) {
                items.add(value(component, depth));
            }
            arr = new Arr(cls, items, null);
        }
        handles.set(slot, arr);
        return arr;
    }

    // ------------------------------------------------------------------ JDK types shown as values

    private static boolean knownWriteObject(String cls) {
        return cls.startsWith("java.util.") || cls.startsWith("java.math.") || cls.startsWith("java.time.") || cls.startsWith("java.lang.");
    }

    private Object shown(Obj o) {
        try {
            switch (o.cls) {
                case "java.lang.Integer", "java.lang.Long", "java.lang.Short", "java.lang.Byte", "java.lang.Double", "java.lang.Float",
                     "java.lang.Boolean", "java.lang.Character":
                    return field(o, "value");
                case "java.math.BigInteger":
                    return bigInteger(o);
                case "java.math.BigDecimal": {
                    Object iv = field(o, "intVal");
                    BigInteger unscaled = iv instanceof Obj bo ? bigInteger(bo) : null;
                    Object scale = field(o, "scale");
                    return unscaled == null || !(scale instanceof Integer s) ? null : new BigDecimal(unscaled, s);
                }
                case "java.util.Date", "java.sql.Timestamp", "java.sql.Date": {
                    byte[] block = block(o.annotation, 0);
                    return block != null && block.length >= 8 ? Instant.ofEpochMilli(java.nio.ByteBuffer.wrap(block).getLong()).toString() : null;
                }
                case "java.time.Ser":
                    return time(block(o.annotation, 0));
                case "java.util.ArrayList", "java.util.LinkedList", "java.util.Vector", "java.util.ArrayDeque",
                     "java.util.Collections$UnmodifiableRandomAccessList", "java.util.Arrays$ArrayList":
                    return items(o, false);
                case "java.util.HashSet", "java.util.LinkedHashSet", "java.util.TreeSet":
                    return items(o, false);
                case "java.util.HashMap", "java.util.LinkedHashMap", "java.util.TreeMap", "java.util.Hashtable", "java.util.concurrent.ConcurrentHashMap":
                    return items(o, true);
                default:
                    return null;
            }
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static Object field(Obj o, String name) {
        for (Object[] f : o.fields) {
            if (name.equals(f[0])) {
                return f[1];
            }
        }
        return null;
    }

    private static BigInteger bigInteger(Obj o) {
        Object signum = field(o, "signum");
        Object mag = field(o, "magnitude");
        if (!(signum instanceof Integer s) || !(mag instanceof Arr a) || a.bytes() == null) {
            return null;
        }
        return new BigInteger(s, a.bytes());
    }

    private static byte[] block(List<Object> annotation, int index) {
        int seen = 0;
        for (Object a : annotation) {
            if (a instanceof Block bl) {
                if (seen++ == index) {
                    return bl.data();
                }
            }
        }
        return null;
    }

    /** The objects written by a collection's writeObject (block data with its sizes skipped). */
    private static Object items(Obj o, boolean map) {
        List<Object> objects = new ArrayList<>();
        for (Object a : o.annotation) {
            if (!(a instanceof Block)) {
                objects.add(a);
            }
        }
        if (map) {
            List<Object[]> pairs = new ArrayList<>();
            for (int i = 0; i + 1 < objects.size(); i += 2) {
                pairs.add(new Object[]{objects.get(i), objects.get(i + 1)});
            }
            return pairs;
        }
        return objects;
    }

    /** java.time's Ser: a type byte, then the value (research R11) - the common ones. */
    private static Object time(byte[] d) {
        if (d == null || d.length == 0) {
            return null;
        }
        java.nio.ByteBuffer buf = java.nio.ByteBuffer.wrap(d);
        byte type = buf.get();
        switch (type) {
            case 1:
                return java.time.Duration.ofSeconds(buf.getLong(), buf.getInt()).toString();
            case 2:
                return Instant.ofEpochSecond(buf.getLong(), buf.getInt()).toString();
            case 3:
                return java.time.LocalDate.of(buf.getInt(), buf.get(), buf.get()).toString();
            case 4:
                return localTime(buf).toString();
            case 5:
                return java.time.LocalDateTime.of(java.time.LocalDate.of(buf.getInt(), buf.get(), buf.get()), localTime(buf)).toString();
            default:
                return null;
        }
    }

    /** LocalTime's compact form: hour, then minute/second/nano only while present (a negative byte ends it). */
    private static java.time.LocalTime localTime(java.nio.ByteBuffer buf) {
        int hour = buf.get();
        int minute = 0;
        int second = 0;
        int nano = 0;
        if (hour < 0) {
            hour = ~hour;
        } else {
            minute = buf.get();
            if (minute < 0) {
                minute = ~minute;
            } else {
                second = buf.get();
                if (second < 0) {
                    second = ~second;
                } else {
                    nano = buf.getInt();
                }
            }
        }
        return java.time.LocalTime.of(hour, minute, second, nano);
    }

    // ------------------------------------------------------------------ rendering

    private static void render(Object v, StringBuilder out, int indent) {
        if (out.length() > 64 * 1024 * 1024) {
            return;
        }
        if (v == null) {
            out.append("null");
        } else if (v instanceof Str s) {
            out.append('"').append(s.value().replace("\\", "\\\\").replace("\"", "\\\"")).append('"');
        } else if (v instanceof EnumVal e) {
            out.append(simple(e.cls())).append('.').append(e.constant());
        } else if (v instanceof Raw r) {
            out.append(r.note());
        } else if (v instanceof Block bl) {
            out.append("‹").append(bl.data().length).append(" bytes written by writeObject›");
        } else if (v instanceof Arr a) {
            if (a.bytes() != null) {
                String text = Resp.utf8(a.bytes());
                out.append(text != null && !text.isEmpty() ? "byte[] \"" + text + "\"" : "byte[" + a.bytes().length + "]");
            } else {
                list(a.items(), out, indent);
            }
        } else if (v instanceof Obj o) {
            Object shown = o.shown;
            if (shown instanceof List<?> l && !l.isEmpty() && l.get(0) instanceof Object[]) {
                out.append(o.cls).append(' ');
                map(l, out, indent);
            } else if (shown instanceof List<?> l) {
                out.append(o.cls).append(' ');
                list(l, out, indent);
            } else if (shown != null) {
                out.append(o.cls.startsWith("java.lang.") || o.cls.startsWith("java.math.") ? "" : o.cls.equals("java.time.Ser") ? "java.time " : o.cls + " ")
                        .append(shown);
            } else {
                out.append(o.cls).append(" {");
                String pad = "  ".repeat(indent + 1);
                for (Object[] f : o.fields) {
                    out.append('\n').append(pad).append(f[0]).append(": ");
                    render(f[1], out, indent + 1);
                }
                for (Object a : o.annotation) {
                    out.append('\n').append(pad).append("(writeObject): ");
                    render(a, out, indent + 1);
                }
                out.append('\n').append("  ".repeat(indent)).append('}');
            }
        } else if (v instanceof String s) {
            out.append('"').append(s).append('"');
        } else {
            out.append(v);
        }
    }

    private static void list(List<?> items, StringBuilder out, int indent) {
        out.append('[');
        boolean multiline = items.stream().anyMatch(x -> x instanceof Obj o && o.shown == null);
        for (int i = 0; i < items.size(); i++) {
            if (multiline) {
                out.append(i > 0 ? "," : "").append('\n').append("  ".repeat(indent + 1));
            } else if (i > 0) {
                out.append(", ");
            }
            render(items.get(i), out, indent + 1);
        }
        if (multiline) {
            out.append('\n').append("  ".repeat(indent));
        }
        out.append(']');
    }

    private static void map(List<?> pairs, StringBuilder out, int indent) {
        out.append('{');
        for (Object p : pairs) {
            Object[] kv = (Object[]) p;
            out.append('\n').append("  ".repeat(indent + 1));
            render(kv[0], out, indent + 1);
            out.append(" → ");
            render(kv[1], out, indent + 1);
        }
        out.append('\n').append("  ".repeat(indent)).append('}');
    }

    private static String simple(String cls) {
        int dot = cls.lastIndexOf('.');
        return dot < 0 ? cls : cls.substring(dot + 1);
    }

    // ------------------------------------------------------------------ primitives

    private byte u1() {
        if (pos >= b.length) {
            throw new IllegalStateException("eof");
        }
        return b[pos++];
    }

    private int u2() {
        return (u1() & 0xff) << 8 | (u1() & 0xff);
    }

    private int s4() {
        return u2() << 16 | u2();
    }

    private long s8() {
        return ((long) s4() << 32) | (s4() & 0xffffffffL);
    }

    private byte[] bytes(int n) {
        if (n < 0 || pos + n > b.length) {
            throw new IllegalStateException("eof");
        }
        byte[] out = java.util.Arrays.copyOfRange(b, pos, pos + n);
        pos += n;
        return out;
    }

    /** Modified UTF-8 as ObjectOutputStream writes it. */
    private String utf(int n) {
        byte[] raw = bytes(n);
        StringBuilder s = new StringBuilder(n);
        for (int i = 0; i < raw.length; i++) {
            int c = raw[i] & 0xff;
            if (c < 0x80) {
                s.append((char) c);
            } else if ((c & 0xe0) == 0xc0 && i + 1 < raw.length) {
                s.append((char) (((c & 0x1f) << 6) | (raw[++i] & 0x3f)));
            } else if ((c & 0xf0) == 0xe0 && i + 2 < raw.length) {
                s.append((char) (((c & 0x0f) << 12) | ((raw[++i] & 0x3f) << 6) | (raw[++i] & 0x3f)));
            } else {
                s.append('?');
            }
        }
        return s.toString();
    }

    static String text(byte[] b) {
        return new String(b, StandardCharsets.UTF_8);
    }

    static String zone() {
        return ZoneOffset.UTC.getId();
    }
}
