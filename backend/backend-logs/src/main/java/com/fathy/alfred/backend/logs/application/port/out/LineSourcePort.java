package com.fathy.alfred.backend.logs.application.port.out;

import java.io.Closeable;
import java.io.IOException;

/**
 * Yields complete lines with their byte offsets from one file, starting at a saved position.
 * For followed files the reader also notices rotation (FR-006): the file was renamed away or
 * truncated, so reading restarts at the beginning of the new file under a new generation.
 */
public interface LineSourcePort {

    /**
     * One complete line (without its line break). {@code generation} increases on every rotation, so
     * offsets of the new file never collide with the old one's.
     */
    record RawLine(byte[] bytes, int generation, long offset, long nextOffset) {
    }

    interface Reader extends Closeable {

        /** @return the next complete line, or null when none is available right now (end of data) */
        RawLine next() throws IOException;

        /**
         * Follow mode: waits up to {@code millis} for new data or a rotation.
         *
         * @return false when the file is currently missing (the input shows WAITING)
         */
        boolean awaitMore(long millis) throws IOException, InterruptedException;

        long size() throws IOException;
    }

    Reader open(String path, int generation, long position) throws IOException;
}
