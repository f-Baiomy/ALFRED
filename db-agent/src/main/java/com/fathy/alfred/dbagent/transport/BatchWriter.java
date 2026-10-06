package com.fathy.alfred.dbagent.transport;

import java.util.List;
import java.util.Map;

/** Serialises one batch to the shape POST /db-capture/agent/batch expects (contracts/agent-ingest.md). */
public final class BatchWriter {

    private BatchWriter() {
    }

    public static String write(String agentId, String project, List<StatementRecord> statements, List<MarkerRecord> markers,
                               Map<String, Long> droppedByCall) {
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
                    .field("at", m.at).field("method", m.method).field("url", m.url).field("thread", m.thread).endObject();
        }
        w.endArray();
        if (!droppedByCall.isEmpty()) {
            w.longMap("droppedByCall", droppedByCall);
        }
        return w.endObject().toString();
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
