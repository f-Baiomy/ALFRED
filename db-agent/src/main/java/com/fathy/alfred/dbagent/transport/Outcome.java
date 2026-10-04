package com.fathy.alfred.dbagent.transport;

import java.util.List;

/** Mirrors backend-db-capture's StatementOutcome - see that record for which fields each kind sets. */
public final class Outcome {
    public String kind;
    public List<String[]> columns;           // {name, type}
    public Long rowsRead;
    public Boolean partial;
    public Boolean overLimit;
    public Long affected;
    public List<Long> perSet;
    public List<List<Value>> generatedKeys;
    public List<Value> outParams;
    public String sqlState;
    public Integer vendorCode;
    public String message;
    public List<String> chain;
    public String txResult;
    public Long heldMicros;

    public Outcome(String kind) {
        this.kind = kind;
    }

    public Outcome copy() {
        Outcome o = new Outcome(kind);
        o.columns = columns;
        o.rowsRead = rowsRead;
        o.partial = partial;
        o.overLimit = overLimit;
        o.affected = affected;
        o.perSet = perSet;
        o.generatedKeys = generatedKeys;
        o.outParams = outParams;
        o.sqlState = sqlState;
        o.vendorCode = vendorCode;
        o.message = message;
        o.chain = chain;
        o.txResult = txResult;
        o.heldMicros = heldMicros;
        return o;
    }
}
