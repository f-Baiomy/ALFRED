package com.fathy.alfred.backend.logs.application.port.in;

import com.fathy.alfred.backend.logs.domain.model.InputKind;
import com.fathy.alfred.backend.logs.domain.model.LogInput;

import java.io.InputStream;
import java.util.List;

/** Inputs: uploads, server files, followed files (FR-002..006, FR-045/046). */
public interface ManageLogInputsUseCase {

    record ServerFile(String path, String name, boolean directory, long size) {
    }

    record UploadTicket(String uploadId, int chunkSize, java.util.Set<Integer> receivedChunks) {
    }

    List<ServerFile> serverFiles(String dir);

    UploadTicket createUpload(String fileName, long size);

    UploadTicket uploadStatus(String uploadId);

    /** Writes one chunk; when the last one arrives the linked input starts loading. */
    UploadTicket writeChunk(String uploadId, int index, InputStream data, long length);

    /**
     * @param ref          server path (SERVER_FILE/FOLLOW) or upload id (UPLOAD)
     * @param fingerprint  client-computed for uploads; server-computed otherwise
     * @param confirmDuplicate load even though this file was already loaded into the source
     */
    LogInput add(String sourceId, InputKind kind, String ref, String fingerprint, boolean fromStart, boolean confirmDuplicate);

    /** Watches a folder of {@code logs_watch_dirs}: its matching files load and are then followed live. */
    LogInput addWatch(String sourceId, com.fathy.alfred.backend.logs.domain.model.WatchOptions options);

    LogInput pause(String sourceId, String inputId);

    LogInput resume(String sourceId, String inputId);

    void delete(String sourceId, String inputId);
}
