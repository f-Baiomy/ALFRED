package com.fathy.alfred.dbagent.transport;

/** A typed value as sent to ALFRED (contracts/agent-ingest.md): JDBC/vendor type name and text form; null value = SQL NULL. */
public final class Value {
    public final String type;
    public final String value;
    public final boolean opaque;
    public final Long truncatedAt;
    public final String direction;

    public Value(String type, String value, boolean opaque, Long truncatedAt, String direction) {
        this.type = type;
        this.value = value;
        this.opaque = opaque;
        this.truncatedAt = truncatedAt;
        this.direction = direction;
    }

    public static Value of(String type, String value) {
        return new Value(type, value, false, null, null);
    }

    public Value withDirection(String newDirection) {
        return new Value(type, value, opaque, truncatedAt, newDirection);
    }

    long approxBytes() {
        return 24 + (type == null ? 0 : type.length()) + (value == null ? 0 : value.length());
    }
}
