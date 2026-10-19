package com.fathy.alfred.backend.links.application.port.in;

import java.nio.ByteBuffer;
import java.util.Map;

/**
 * Where a relayed response arrives on the reader (R3): the head, then the body in chunks, then the end - or an error at
 * any point ({@code OFFLINE} when the link drops). Called on the connection's thread: never block here for long; the
 * owner sends no more than the credit the reader gave.
 */
public interface ResponseSink {

    void head(int status, Map<String, String> headers);

    void chunk(ByteBuffer data);

    void end();

    void error(String code, String message);
}
