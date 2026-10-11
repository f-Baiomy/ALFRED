package com.fathy.alfred.backend.board.domain.model;

/**
 * A call a cycle captured (or a live one), with its signature ({@code <signal>|<METHOD> <endpoint pattern>}) - what a fix
 * check compares - its time and how long it took (null when unknown).
 */
public record CycleCall(String direction, String callId, String method, String path, Integer status, String signature,
                        java.time.Instant at, Double durationMs) {

    public CycleCall(String direction, String callId, String method, String path, Integer status, String signature) {
        this(direction, callId, method, path, status, signature, null, null);
    }

    public CycleCall(String direction, String callId, String method, String path, Integer status, String signature,
                     java.time.Instant at) {
        this(direction, callId, method, path, status, signature, at, null);
    }

    /** A live call as a mention ref: {@code in:<id>}. */
    public String liveRef() {
        return direction + ":" + callId;
    }

    /** The call as a mention ref: {@code in:<id>@<cycle>}. */
    public String ref(String cycleId) {
        return direction + ":" + callId + "@" + cycleId;
    }

    /** {@code 5xx}, {@code 4xx}, {@code error} or {@code ok}. */
    public String signal() {
        int bar = signature == null ? -1 : signature.indexOf('|');
        return bar < 0 ? "" : signature.substring(0, bar);
    }

    /** {@code METHOD pattern}, the endpoint part of the signature. */
    public String endpoint() {
        int bar = signature == null ? -1 : signature.indexOf('|');
        return bar < 0 ? "" : signature.substring(bar + 1);
    }
}
