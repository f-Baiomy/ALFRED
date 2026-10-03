package com.fathy.alfred.backend.logs.application.port.out;

import java.io.IOException;
import java.io.InputStream;
import java.util.List;

/**
 * Files on the backend's disk: the read-only server-logs folder (FR-002) and assembled uploads
 * (FR-003). Every server path is resolved inside the configured root; anything outside is rejected.
 */
public interface LogFilesPort {

    record Entry(String path, String name, boolean directory, long size) {
    }

    /** Lists a folder under the server-logs root ("" = the root). */
    List<Entry> list(String relativeDir) throws IOException;

    /** Absolute path of a server file, or IllegalArgumentException when it is outside the root or missing. */
    String resolveServerFile(String relativePath);

    String fingerprint(String absolutePath) throws IOException;

    /** Up to {@code max} complete lines from the start of a file (structure preview). */
    List<String> head(String absolutePath, int max) throws IOException;

    String uploadPath(String uploadId);

    void writeChunk(String uploadId, long offset, InputStream data, long length) throws IOException;

    /** Writes lines to a new upload file (used to move "different structure" lines to a new source). */
    String writeUpload(String uploadId, Iterable<String> lines) throws IOException;

    void deleteUpload(String uploadId);
}
