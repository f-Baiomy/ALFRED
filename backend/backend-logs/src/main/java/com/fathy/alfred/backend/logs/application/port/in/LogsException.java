package com.fathy.alfred.backend.logs.application.port.in;

/** An expected failure of a logs use case; the web adapter maps {@link Kind} to an HTTP status. */
public class LogsException extends RuntimeException {

    public enum Kind { NOT_FOUND, BAD_REQUEST, CONFLICT, TOO_LARGE, UNAVAILABLE }

    private final Kind kind;

    public LogsException(Kind kind, String message) {
        super(message);
        this.kind = kind;
    }

    public Kind kind() {
        return kind;
    }

    public static LogsException notFound(String what) {
        return new LogsException(Kind.NOT_FOUND, what + " not found");
    }

    public static LogsException bad(String message) {
        return new LogsException(Kind.BAD_REQUEST, message);
    }
}
