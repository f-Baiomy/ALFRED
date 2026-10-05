package com.fathy.alfred.dbagent.capture;

import com.fathy.alfred.dbagent.transport.OriginRecord;

import java.lang.reflect.Array;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Where a statement came from when Hibernate made it. While a query the code wrote runs (HQL/JPQL, native SQL,
 * Criteria) or Hibernate makes SQL on its own (a collection or entity loaded, a flush), a frame sits on this thread's
 * stack; every statement executed meanwhile is tagged with the innermost one. Everything is reached by reflection and
 * class name, so no Hibernate version is a dependency - 4, 5 and 6 differ in packages, not in these names.
 *
 * <p>Recording only: nothing here changes what the query does. Parameter values are rendered without calling an
 * application object's toString (an entity's could load lazily) - only JDK values are printed as they are.
 */
final class OriginTracker {

    private static final int MAX_TEXT = 64 * 1024;
    private static final int MAX_VALUE = 500;
    private static final int MAX_ITEMS = 20;
    private static final Method NONE;

    static {
        try {
            NONE = Object.class.getMethod("hashCode");
        } catch (NoSuchMethodException e) {
            throw new ExceptionInInitializerError(e);
        }
    }

    private final String prefix;
    private final AtomicLong ids = new AtomicLong();
    private final WeakIdentityMap<QueryState> queries = new WeakIdentityMap<>();
    private final ThreadLocal<ArrayList<Frame>> stack = ThreadLocal.withInitial(ArrayList::new);
    private final ConcurrentHashMap<String, Method> methods = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<Class<?>, String> kinds = new ConcurrentHashMap<>();

    OriginTracker(String agentId) {
        this.prefix = agentId + ":q";
    }

    /** The innermost query or event running on this thread, or null. */
    OriginRecord current() {
        ArrayList<Frame> frames = stack.get();
        return frames.isEmpty() ? null : frames.get(frames.size() - 1).origin;
    }

    // ------------------------------------------------------------------ queries

    void named(Object query, String name) {
        state(query).name = name;
    }

    void parameter(Object query, String method, Object[] args) {
        if (args == null || args.length == 0) {
            return;
        }
        QueryState state = state(query);
        synchronized (state) {
            if (method.equals("setFirstResult")) {
                state.firstResult = args[0] instanceof Number ? ((Number) args[0]).intValue() : null;
            } else if (method.equals("setMaxResults")) {
                state.maxResults = args[0] instanceof Number ? ((Number) args[0]).intValue() : null;
            } else if (args.length >= 2) {
                String name = parameterName(args[0]);
                if (name != null) {
                    state.params.put(name, render(args[1]));
                }
            }
        }
    }

    Object queryEnter(Object query, String method) {
        ArrayList<Frame> frames = stack.get();
        Frame top = frames.isEmpty() ? null : frames.get(frames.size() - 1);
        String text = queryText(query);
        String kind = kind(query);
        QueryState state = queries.get(query);
        if (top != null && top.query && (top.owner == query || top.origin.text == null || text == null || top.origin.text.equals(text))) {
            // The same execution again: getResultList delegating to list, or a JPA wrapper around Hibernate's own
            // query. The outer frame keeps the code's method; the inner one may know what the wrapper did not.
            OriginRecord o = top.origin;
            if (o.text == null && text != null) {
                o.text = text;
                o.kind = kind;
            }
            if (state != null) {
                synchronized (state) {
                    if (o.name == null) {
                        o.name = state.name;
                    }
                    if (o.params == null && !state.params.isEmpty()) {
                        o.params = params(state);
                    }
                    if (o.firstResult == null) {
                        o.firstResult = state.firstResult;
                    }
                    if (o.maxResults == null) {
                        o.maxResults = state.maxResults;
                    }
                }
            }
            return null;
        }
        OriginRecord o = new OriginRecord();
        o.id = prefix + ids.incrementAndGet();
        o.kind = kind;
        o.text = text;
        o.method = method;
        o.parentId = enclosingQuery(frames);
        if (state != null) {
            synchronized (state) {
                o.name = state.name;
                o.params = state.params.isEmpty() ? null : params(state);
                o.firstResult = state.firstResult;
                o.maxResults = state.maxResults;
            }
        }
        return push(frames, query, o, true);
    }

    // ------------------------------------------------------------------ events

    Object eventEnter(String type, Object self, Object[] args) {
        ArrayList<Frame> frames = stack.get();
        OriginRecord o = new OriginRecord();
        o.id = prefix + ids.incrementAndGet();
        o.parentId = enclosingQuery(frames);
        Object event = args != null && args.length > 0 ? args[0] : null;
        if (type.endsWith("DefaultInitializeCollectionEventListener")) {
            o.kind = "LAZY_LOAD";
            Object collection = call(event, "getCollection");
            o.role = shortRole((String) call(collection, "getRole"));
            o.entity = entityOfRole(o.role);
            o.entityId = id(call(collection, "getKey"));
        } else if (type.endsWith("DefaultLoadEventListener")) {
            o.kind = "LOAD";
            o.entity = simpleName((String) call(event, "getEntityClassName"));
            o.entityId = id(call(event, "getEntityId"));
        } else if (type.endsWith("FlushEventListener")) {
            o.kind = "FLUSH";
        } else {
            flushAction(type, self, o);
        }
        return push(frames, self, o, false);
    }

    /** One action a flush (or an immediate identity insert) executes: what it did to which entity or collection. */
    private void flushAction(String type, Object action, OriginRecord o) {
        o.kind = "FLUSH";
        String simple = type.substring(type.lastIndexOf('.') + 1);
        if (simple.startsWith("Collection")) {
            o.action = "COLLECTION";
            Object persister = call(action, "getPersister");
            o.role = shortRole((String) call(persister, "getRole"));
            o.entity = entityOfRole(o.role);
            o.entityId = id(call(action, "getKey"));
            return;
        }
        o.action = simple.contains("Insert") ? "INSERT" : simple.contains("Update") ? "UPDATE" : simple.contains("Delete") ? "DELETE" : simple;
        o.entity = simpleName((String) call(action, "getEntityName"));
        o.entityId = id(call(action, "getId"));
        if ("UPDATE".equals(o.action)) {
            Object dirty = field(action, "dirtyFields");
            Object names = call(call(action, "getPersister"), "getPropertyNames");
            if (dirty instanceof int[] && names instanceof String[]) {
                List<String> changed = new ArrayList<>();
                for (int i : (int[]) dirty) {
                    if (i >= 0 && i < ((String[]) names).length) {
                        changed.add(((String[]) names)[i]);
                    }
                }
                o.changed = changed.isEmpty() ? null : changed;
            }
        }
    }

    void exit(Object token) {
        ArrayList<Frame> frames = stack.get();
        // Normally the top; anything above it was left by a hook that never exited (an error the advice swallowed).
        for (int i = frames.size() - 1; i >= 0; i--) {
            if (frames.get(i) == token) {
                while (frames.size() > i) {
                    frames.remove(frames.size() - 1);
                }
                return;
            }
        }
    }

    private static Frame push(ArrayList<Frame> frames, Object owner, OriginRecord origin, boolean query) {
        Frame frame = new Frame(owner, origin, query);
        frames.add(frame);
        return frame;
    }

    private static String enclosingQuery(ArrayList<Frame> frames) {
        for (int i = frames.size() - 1; i >= 0; i--) {
            if (frames.get(i).query) {
                return frames.get(i).origin.id;
            }
        }
        return null;
    }

    private QueryState state(Object query) {
        QueryState state = queries.get(query);
        if (state == null) {
            state = new QueryState();
            queries.put(query, state);
        }
        return state;
    }

    private static List<String[]> params(QueryState state) {
        List<String[]> list = new ArrayList<>();
        for (Map.Entry<String, String> e : state.params.entrySet()) {
            list.add(new String[]{e.getKey(), e.getValue()});
        }
        return list;
    }

    // ------------------------------------------------------------------ reflection

    private String queryText(Object query) {
        Object text = call(query, "getQueryString");
        if (text == null) {
            text = call(query, "getProcedureName");
        }
        if (text == null && kind(query).equals("CRITERIA")) {
            text = String.valueOf(query); // the legacy CriteriaImpl prints its restrictions
        }
        if (!(text instanceof String)) {
            return null;
        }
        String s = (String) text;
        return s.length() > MAX_TEXT ? s.substring(0, MAX_TEXT) : s;
    }

    /** NATIVE (createNativeQuery/createSQLQuery, a stored procedure), CRITERIA or HQL - by the query's class. */
    private String kind(Object query) {
        Class<?> type = query.getClass();
        String kind = kinds.get(type);
        if (kind == null) {
            kind = "HQL";
            for (Class<?> c = type; c != null && c != Object.class; c = c.getSuperclass()) {
                String k = kindOf(c.getName());
                for (int i = 0; k == null && i < c.getInterfaces().length; i++) {
                    k = kindOf(c.getInterfaces()[i].getName());
                }
                if (k != null) {
                    kind = k;
                    break;
                }
            }
            kinds.put(type, kind);
        }
        return kind;
    }

    private static String kindOf(String name) {
        if (name.contains("Native") || name.contains("SQLQuery") || name.contains("Procedure")) {
            return "NATIVE";
        }
        return name.contains("Criteria") ? "CRITERIA" : null;
    }

    private String parameterName(Object key) {
        if (key instanceof String) {
            return ":" + key;
        }
        if (key instanceof Number) {
            return "?" + key;
        }
        Object name = call(key, "getName"); // a javax/jakarta Parameter or Hibernate's QueryParameter
        if (name instanceof String) {
            return ":" + name;
        }
        Object position = call(key, "getPosition");
        return position instanceof Number ? "?" + position : null;
    }

    /** No-arg method by name, found up the hierarchy (protected ones too), cached per class; null when absent. */
    private Object call(Object target, String name) {
        if (target == null) {
            return null;
        }
        String key = target.getClass().getName() + '#' + name;
        Method m = methods.get(key);
        if (m == null) {
            m = find(target.getClass(), name);
            methods.put(key, m == null ? NONE : m);
        }
        if (m == NONE) {
            return null;
        }
        try {
            return m.invoke(target);
        } catch (Throwable t) {
            return null;
        }
    }

    private static Method find(Class<?> type, String name) {
        try {
            Method m = type.getMethod(name);
            m.setAccessible(true);
            return m;
        } catch (Throwable ignored) {
            // not public - look for a protected one below
        }
        for (Class<?> c = type; c != null && c != Object.class; c = c.getSuperclass()) {
            try {
                Method m = c.getDeclaredMethod(name);
                m.setAccessible(true);
                return m;
            } catch (Throwable ignored) {
                // next superclass
            }
        }
        return null;
    }

    private static Object field(Object target, String name) {
        for (Class<?> c = target.getClass(); c != null && c != Object.class; c = c.getSuperclass()) {
            try {
                Field f = c.getDeclaredField(name);
                f.setAccessible(true);
                return f.get(target);
            } catch (NoSuchFieldException next) {
                // next superclass
            } catch (Throwable t) {
                return null;
            }
        }
        return null;
    }

    // ------------------------------------------------------------------ rendering

    /** A parameter value for display. JDK values print as they are; an application object (an entity) only by its
     *  class name - its toString could load lazily or be expensive. */
    static String render(Object value) {
        String s = renderValue(value);
        return s.length() > MAX_VALUE ? s.substring(0, MAX_VALUE) + "…" : s;
    }

    private static String renderValue(Object value) {
        if (value == null) {
            return "null";
        }
        if (value instanceof CharSequence) {
            return "'" + value + "'";
        }
        if (value instanceof Collection) {
            return items(((Collection<?>) value).iterator(), ((Collection<?>) value).size());
        }
        if (value.getClass().isArray() && !(value instanceof byte[])) {
            List<Object> list = new ArrayList<>();
            int n = Array.getLength(value);
            for (int i = 0; i < Math.min(n, MAX_ITEMS); i++) {
                list.add(Array.get(value, i));
            }
            return items(list.iterator(), n);
        }
        if (value instanceof byte[]) {
            return "<" + ((byte[]) value).length + " bytes>";
        }
        if (value instanceof Enum) {
            return ((Enum<?>) value).name();
        }
        if (value.getClass().getName().startsWith("java.")) {
            return String.valueOf(value);
        }
        return "<" + value.getClass().getSimpleName() + ">";
    }

    private static String items(Iterator<?> it, int size) {
        StringBuilder b = new StringBuilder("[");
        int i = 0;
        while (it.hasNext() && i < MAX_ITEMS) {
            if (i++ > 0) {
                b.append(", ");
            }
            b.append(renderValue(it.next()));
        }
        if (size > MAX_ITEMS) {
            b.append(", … ").append(size - MAX_ITEMS).append(" more");
        }
        return b.append(']').toString();
    }

    private static String id(Object id) {
        return id == null ? null : id instanceof CharSequence ? id.toString() : render(id);
    }

    private static String simpleName(String className) {
        return className == null ? null : className.substring(className.lastIndexOf('.') + 1);
    }

    /** {@code com.acme.UserGroup.supplierSettings} - from the first capitalised segment: {@code UserGroup.supplierSettings}. */
    static String shortRole(String role) {
        if (role == null) {
            return null;
        }
        String[] parts = role.split("\\.");
        for (int i = 0; i < parts.length; i++) {
            if (!parts[i].isEmpty() && Character.isUpperCase(parts[i].charAt(0))) {
                StringBuilder b = new StringBuilder(parts[i]);
                for (int j = i + 1; j < parts.length; j++) {
                    b.append('.').append(parts[j]);
                }
                return b.toString();
            }
        }
        return role;
    }

    private static String entityOfRole(String role) {
        if (role == null) {
            return null;
        }
        int dot = role.indexOf('.');
        return dot < 0 ? role : role.substring(0, dot);
    }

    private static final class QueryState {
        volatile String name;
        final Map<String, String> params = new LinkedHashMap<>();
        Integer firstResult;
        Integer maxResults;
    }

    private static final class Frame {
        final Object owner;
        final OriginRecord origin;
        final boolean query;

        Frame(Object owner, OriginRecord origin, boolean query) {
            this.owner = owner;
            this.origin = origin;
            this.query = query;
        }
    }
}
