package com.fathy.alfred.backend.logs.application.port.out;

import com.fathy.alfred.backend.logs.domain.model.LogInput;

import java.util.List;
import java.util.Optional;

/** Inputs and chunked-upload bookkeeping. */
public interface LogInputStorePort {

    List<LogInput> bySource(String sourceId);

    List<LogInput> all();

    Optional<LogInput> get(String inputId);

    void save(LogInput input);

    void delete(String inputId);

    /** Re-reads an input from the start (retry after a structure split, or a deleted input re-added). */
    void resetPosition(String inputId);

    record Upload(String id, String fileName, long size, int chunkSize, java.util.Set<Integer> received, String inputId) {
    }

    void saveUpload(Upload upload);

    Optional<Upload> upload(String uploadId);

    void deleteUpload(String uploadId);

    /** The old "different structure" counters, once those lines were re-read with their own fields. */
    void clearMismatchCounts(String sourceId);

    /** The files of a watched folder (WATCHED_FILE inputs whose parent is {@code parentId}). */
    List<LogInput> byParent(String parentId);

    /**
     * Sets where reading starts, before an input has stored anything (a watched file starting at its last
     * N lines or at its end). Afterwards positions only move in the batch transaction.
     */
    void setPosition(String inputId, long position);
}
