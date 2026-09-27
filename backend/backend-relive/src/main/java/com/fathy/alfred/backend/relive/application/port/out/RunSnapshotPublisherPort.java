package com.fathy.alfred.backend.relive.application.port.out;

import com.fasterxml.jackson.databind.JsonNode;

/** Outbound port: publishes/removes the per-run proxy snapshot files the addons read
 *  (contracts/proxy-snapshot.md), and the shared in-flight tracking file. */
public interface RunSnapshotPublisherPort {

    void publish(String runId, JsonNode snapshotJson);

    /** Deletes the run's snapshot file and its answers directory (relive/answers/<runId>/). */
    void unpublish(String runId);

    void publishInflight(JsonNode inflightJson);

    void clearInflight();

    /** Writes one answer file under relive/answers/<runId>/<answerId>.{meta.json,body} (T033/T035). */
    void writeAnswer(String runId, String answerId, JsonNode meta, byte[] body);
}
