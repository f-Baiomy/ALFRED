package com.fathy.alfred.backend.relive.application.port.out;

/** Outbound port: how the application core fans out "something changed" over /ws/relive -
 *  no payload for cycleChanged (frontend refetches the cheap list), a payload for the other two
 *  so a listening run view can update without a refetch. */
public interface ReliveNotificationPort {

    void cycleChanged();

    void runChanged(String cycleId, String runId);

    /** {@code eventJson} is the exact {"type":"run-call",...} payload to broadcast verbatim. */
    void runCall(com.fasterxml.jackson.databind.JsonNode eventJson);
}
