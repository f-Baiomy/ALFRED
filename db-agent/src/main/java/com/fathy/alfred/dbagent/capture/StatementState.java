package com.fathy.alfred.dbagent.capture;

import com.fathy.alfred.dbagent.transport.Value;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** What the agent knows about one JDBC statement object: its SQL, the parameters set so far, its batch, its pending record. */
final class StatementState {

    final Object connection;
    final String sql;
    /** Index (Integer) or name (String, CallableStatement) to value. TreeMap so ?1, ?2 ... come out in order. */
    final Map<Object, Value> current = new TreeMap<>(StatementState::compare);
    final List<List<Value>> batchSets = new ArrayList<>();
    final List<String> batchSqls = new ArrayList<>();
    final List<Object> outParameters = new ArrayList<>();
    volatile PendingStatement pending;

    StatementState(Object connection, String sql) {
        this.connection = connection;
        this.sql = sql;
    }

    private static int compare(Object a, Object b) {
        if (a instanceof Integer && b instanceof Integer) {
            return Integer.compare((Integer) a, (Integer) b);
        }
        return a.toString().compareTo(b.toString());
    }

    synchronized List<Value> snapshot() {
        List<Value> values = new ArrayList<>(current.size());
        for (Map.Entry<Object, Value> e : current.entrySet()) {
            Value v = e.getValue();
            values.add(outParameters.contains(e.getKey()) && v.direction == null ? v.withDirection("INOUT") : v);
        }
        for (Object out : outParameters) {
            if (!current.containsKey(out)) {
                values.add(new Value("OUT", null, false, null, "OUT"));
            }
        }
        return values;
    }
}
