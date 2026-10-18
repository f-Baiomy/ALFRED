package com.fathy.alfred.backend.sessioncycles.domain.model;

import java.util.List;

/**
 * What a cycle caught, counted from its captured calls without their bodies (specs/033, GET /session-cycles/{id}/summary):
 * the board's Cycles tab shows a row from it, compares two cycles with it and ticks a description's steps against its
 * endpoints. Inbound (calls into the project) and outbound (supplier calls) are counted together; each endpoint and
 * point says which.
 *
 * @param failed       calls answered 4xx/5xx or with an error
 * @param hosts        the hosts the calls went to - the environment the cycle ran against
 * @param strip        the calls in time order (the last {@link #STRIP_MAX}), for the status strip and live counters
 * @param inboundCallIds the inbound calls' ids (the first {@link #IDS_MAX}) - the board asks db-capture for their counts
 */
public record CycleSummary(
        String cycleId,
        int calls,
        int failed,
        String firstAt,
        String lastAt,
        Double medianMs,
        List<String> hosts,
        List<Endpoint> endpoints,
        List<Point> strip,
        List<String> inboundCallIds
) {
    public static final int STRIP_MAX = 300;
    public static final int IDS_MAX = 500;

    /** One METHOD + path (no query string) of the cycle. */
    public record Endpoint(String direction, String method, String path, int calls, int failed, Integer lastStatus,
                           Double medianMs, Double maxMs, String lastAt) {
    }

    /** One call of the strip. */
    public record Point(String direction, String callId, String at, String method, String path, Integer status, Double ms, boolean failed) {
    }
}
