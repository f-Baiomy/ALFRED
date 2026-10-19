package com.fathy.alfred.backend.links.application.port.in;

import java.io.IOException;
import java.util.Map;

/**
 * How the owner answers a relayed read (R3). {@link #write} blocks until the reader has room (credit) and throws when
 * the reader cancelled or the link dropped, so a 200 MB body crosses without either side holding it whole.
 */
public interface ResponseWriter {

    void head(int status, Map<String, String> headers) throws IOException;

    void write(byte[] data, int offset, int length) throws IOException;

    void end() throws IOException;

    void error(String code, String message);

    boolean cancelled();

    default void write(byte[] data) throws IOException {
        write(data, 0, data.length);
    }
}
