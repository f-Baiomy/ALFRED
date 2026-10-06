package com.fathy.alfred.dbagent.transport;

import java.util.List;
import java.util.Map;

/** Serialises one batch to the shape POST /db-capture/agent/batch expects (contracts/agent-ingest.md). */
public final class BatchWriter {

    private BatchWriter() {
    }

    public static String write(String agentId, String project, List<StatementRecord> statements, List<MarkerRecord> markers,
                               Map<String, Long> droppedByCall) {
        return write(agentId, project, statements, markers, droppedByCall, java.util.Collections.<LogRecord>emptyList(),
                java.util.Collections.<String, Long>emptyMap());
    }

    public static String write(String agentId, String project, List<StatementRecord> statements, List<MarkerRecord> markers,
                               Map<String, Long> droppedByCall, List<LogRecord> logs, Map<String, Long> droppedLogs) {
        return write(agentId, project, statements, markers, droppedByCall, logs, droppedLogs, java.util.Collections.<RedisCommandRecord>emptyList(),
                java.util.Collections.<RedisChunkRecord>emptyList(), java.util.Collections.<String, Long>emptyMap());
    }

    public static String write(String agentId, String project, List<StatementRecord> statements, List<MarkerRecord> markers,
                               Map<String, Long> droppedByCall, List<LogRecord> logs, Map<String, Long> droppedLogs,
                               List<RedisCommandRecord> redis, List<RedisChunkRecord> chunks, Map<String, Long> droppedRedis) {
        JsonWriter w = new JsonWriter();
        w.beginObject().name("agentId").value(agentId).name("project").value(project);
        w.name("statements").beginArray();
        for (StatementRecord s : statements) {
            statement(w, s);
        }
        w.endArray();
        w.name("markers").beginArray();
        for (MarkerRecord m : markers) {
            w.beginObject().name("callId").value(m.callId).name("seq").value(m.seq).name("type").value(m.type)
                    .field("at", m.at).field("method", m.method).field("url", m.url).field("thread", m.thread);
            if (m.logs) {
                w.name("logs").value(true);
                if (m.logLevel != null) {
                    w.name("logLevel").value(m.logLevel);
                }
            }
            if (m.redis) {
                w.name("redis").value(true);
            }
            w.endObject();
        }
        w.endArray();
        if (!logs.isEmpty()) {
            w.name("logs").beginArray();
            for (LogRecord l : logs) {
                w.beginObject().field("callId", l.callId).name("seq").value(l.seq).field("at", l.at).field("level", l.level)
                        .field("logger", l.logger).field("thread", l.thread).field("message", l.message)
                        .field("exceptionType", l.exceptionType).field("exceptionMessage", l.exceptionMessage)
                        .field("exceptionStack", l.exceptionStack);
                if (l.cut) {
                    w.name("cut").value(true);
                }
                w.endObject();
            }
            w.endArray();
        }
        if (!droppedLogs.isEmpty()) {
            w.longMap("droppedLogs", droppedLogs);
        }
        if (!redis.isEmpty()) {
            w.name("redis").beginArray();
            for (RedisCommandRecord r : redis) {
                redis(w, r);
            }
            w.endArray();
        }
        if (!chunks.isEmpty()) {
            w.name("redisChunks").beginArray();
            for (RedisChunkRecord c : chunks) {
                w.beginObject().name("sid").value(c.sid).name("which").value(c.which).name("part").value(c.part).name("of").value(c.of)
                        .name("data").value(BASE64.encodeToString(c.data)).endObject();
            }
            w.endArray();
        }
        if (!droppedRedis.isEmpty()) {
            w.longMap("droppedRedis", droppedRedis);
        }
        if (!droppedByCall.isEmpty()) {
            w.longMap("droppedByCall", droppedByCall);
        }
        return w.endObject().toString();
    }

    private static final java.util.Base64.Encoder BASE64 = java.util.Base64.getEncoder();

    /** One Redis command (contracts/agent-redis-capture.md). */
    static void redis(JsonWriter w, RedisCommandRecord r) {
        w.beginObject().name("sid").value(r.sid).field("callId", r.callId).field("runTag", r.runTag).name("seq").value(r.seq)
                .field("at", r.at).name("micros").value(r.micros).field("command", r.command);
        w.stringArray("keys", r.keys == null ? java.util.Collections.<String>emptyList() : r.keys);
        w.name("keysTotal").value(r.keysTotal);
        if (r.args != null) {
            w.name("args").value(BASE64.encodeToString(r.args));
        }
        if (r.reply != null) {
            w.name("reply").value(BASE64.encodeToString(r.reply));
        }
        w.field("replyType", r.replyType).name("resp").value(r.resp).field("error", r.error)
                .name("argsBytes").value(r.argsBytes).name("replyBytes").value(r.replyBytes);
        if (r.chunked) {
            w.name("chunked").value(true);
        }
        w.field("client", r.client).field("connection", r.connection).field("server", r.server).name("db").value(r.db)
                .field("thread", r.thread).field("code", r.code);
        if (r.callers != null && !r.callers.isEmpty()) {
            w.stringArray("callers", r.callers);
        }
        if (r.originCache != null || r.originMethod != null) {
            w.name("origin").beginObject().name("store").value("spring-cache").field("cache", r.originCache)
                    .field("operation", r.originOperation).field("method", r.originMethod).endObject();
        }
        if (r.groupKind != null) {
            w.name("group").beginObject().name("kind").value(r.groupKind).name("id").value(r.groupId)
                    .name("index").value(r.groupIndex).name("size").value(r.groupSize).endObject();
        }
        if (r.poolWaitMicros >= 0) {
            w.name("poolWaitMicros").value(r.poolWaitMicros);
        }
        if (r.before != null) {
            w.name("before").value(BASE64.encodeToString(r.before));
        }
        w.field("beforeType", r.beforeType).field("beforeNote", r.beforeNote);
        if (r.beforeBytes > 0) {
            w.name("beforeBytes").value(r.beforeBytes);
        }
        w.field("fingerprint", r.fingerprint).endObject();
    }

    /** The heartbeat's "redis": {clients: [...], springCaches: [...]} (contracts/agent-redis-capture.md). */
    @SuppressWarnings("unchecked")
    static void redisSeen(JsonWriter w, Map<String, Object> seen) {
        if (seen == null) {
            return;
        }
        w.name("redis").beginObject().name("clients").beginArray();
        Object clients = seen.get("clients");
        if (clients instanceof List) {
            for (Object o : (List<Object>) clients) {
                Map<String, Object> c = (Map<String, Object>) o;
                w.beginObject().field("client", (String) c.get("client")).field("version", (String) c.get("version"))
                        .name("connections").value(((Number) c.get("connections")).longValue());
                java.util.List<String> servers = new java.util.ArrayList<>();
                for (Object s : (List<Object>) c.get("servers")) {
                    servers.add(String.valueOf(s));
                }
                w.stringArray("servers", servers);
                w.name("dbs").beginArray();
                for (Object d : (List<Object>) c.get("dbs")) {
                    w.value(((Number) d).longValue());
                }
                w.endArray().endObject();
            }
        }
        w.endArray();
        java.util.List<String> caches = new java.util.ArrayList<>();
        Object names = seen.get("springCaches");
        if (names instanceof List) {
            for (Object n : (List<Object>) names) {
                caches.add(String.valueOf(n));
            }
        }
        w.stringArray("springCaches", caches).endObject();
    }

    static void statement(JsonWriter w, StatementRecord s) {
        w.beginObject().name("sid").value(s.sid).field("callId", s.callId).field("runTag", s.runTag).name("thread").value(s.thread)
                .name("seq").value(s.seq).name("kind").value(s.kind).name("sql").value(s.sql).field("fingerprint", s.fingerprint)
                .field("table", s.table);
        if (s.params != null) {
            w.name("params");
            rows(w, s.params);
        }
        w.name("outcome");
        outcome(w, s.outcome);
        if (s.rows != null) {
            w.name("rows");
            rows(w, s.rows);
        }
        if (s.rowsFrom > 0) {
            w.name("rowsFrom").value(s.rowsFrom);
        }
        if (s.beforeImageRows != null) {
            w.name("beforeImageRows");
            rows(w, s.beforeImageRows);
        }
        if (s.beforeImage != null) {
            w.name("beforeImage").beginObject().field("source", s.beforeImage.source).field("extraReadMicros", s.beforeImage.extraReadMicros)
                    .field("skippedReason", s.beforeImage.skippedReason).field("rowCount", s.beforeImage.rowCount);
            if (s.beforeImage.columns != null) {
                w.name("columns");
                columns(w, s.beforeImage.columns);
            }
            w.endObject();
        }
        w.field("startedAt", s.startedAt).name("durationMicros").value(s.durationMicros).name("offsetMicros").value(s.offsetMicros)
                .field("txId", s.txId).field("connectionId", s.connectionId).field("codeLocation", s.codeLocation)
                .field("dataSource", s.dataSource).stringArray("cascadesTo", s.cascadesTo).stringArray("callers", s.callers);
        if (s.indexes != null && !s.indexes.isEmpty()) {
            w.name("indexes").beginArray();
            for (IndexRecord ix : s.indexes) {
                w.beginObject().name("name").value(ix.name).name("unique").value(ix.unique).stringArray("columns", ix.columns).endObject();
            }
            w.endArray();
        }
        if (s.origin != null) {
            w.name("origin");
            origin(w, s.origin);
        }
        w.endObject();
    }

    static void origin(JsonWriter w, OriginRecord o) {
        w.beginObject().name("id").value(o.id).name("kind").value(o.kind).field("text", o.text).field("name", o.name)
                .field("method", o.method);
        if (o.params != null) {
            w.name("params").beginArray();
            for (String[] p : o.params) {
                w.beginObject().name("name").value(p[0]).field("value", p[1]).endObject();
            }
            w.endArray();
        }
        w.field("firstResult", o.firstResult).field("maxResults", o.maxResults).field("entity", o.entity).field("entityId", o.entityId)
                .field("role", o.role).field("action", o.action).stringArray("changed", o.changed).field("parentId", o.parentId);
        w.endObject();
    }

    static void outcome(JsonWriter w, Outcome o) {
        w.beginObject().name("kind").value(o.kind);
        if (o.columns != null) {
            w.name("columns");
            columns(w, o.columns);
        }
        w.field("rowsRead", o.rowsRead).field("partial", o.partial).field("overLimit", o.overLimit).field("affected", o.affected);
        if (o.perSet != null) {
            w.name("perSet").beginArray();
            for (Long n : o.perSet) {
                w.value(n);
            }
            w.endArray();
        }
        if (o.generatedKeys != null) {
            w.name("generatedKeys");
            rows(w, o.generatedKeys);
        }
        if (o.outParams != null) {
            w.name("outParams").beginArray();
            for (Value v : o.outParams) {
                value(w, v);
            }
            w.endArray();
        }
        w.field("sqlState", o.sqlState).field("vendorCode", o.vendorCode).field("message", o.message).stringArray("chain", o.chain)
                .field("txResult", o.txResult).field("heldMicros", o.heldMicros).field("acquireMicros", o.acquireMicros)
                .field("via", o.via).field("beginMicros", o.beginMicros).field("commitMicros", o.commitMicros).field("closeMicros", o.closeMicros);
        w.endObject();
    }

    private static void columns(JsonWriter w, List<String[]> columns) {
        w.beginArray();
        for (String[] c : columns) {
            w.beginObject().name("name").value(c[0]).name("type").value(c[1]).endObject();
        }
        w.endArray();
    }

    private static void rows(JsonWriter w, List<List<Value>> rows) {
        w.beginArray();
        for (List<Value> row : rows) {
            w.beginArray();
            for (Value v : row) {
                value(w, v);
            }
            w.endArray();
        }
        w.endArray();
    }

    static void value(JsonWriter w, Value v) {
        if (v == null) {
            w.nullValue();
            return;
        }
        w.beginObject().field("type", v.type).name("value").value(v.value);
        if (v.opaque) {
            w.name("opaque").value(true);
        }
        w.field("truncatedAt", v.truncatedAt).field("direction", v.direction).endObject();
    }
}
