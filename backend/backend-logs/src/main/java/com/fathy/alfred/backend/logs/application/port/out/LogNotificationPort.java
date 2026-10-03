package com.fathy.alfred.backend.logs.application.port.out;

import com.fathy.alfred.backend.logs.domain.model.IngestProgress;

/** "Something changed" signals for /ws/logs (FR-036). The explorer re-fetches; no list data is pushed. */
public interface LogNotificationPort {

    void linesAdded(String sourceId, long count, long newestTs);

    void progress(IngestProgress progress);

    void structureChanged(String sourceId, String rebuilding);

    void sourcesChanged();

    void commentChanged(String sourceId, String lineId);
}
