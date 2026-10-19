package com.fathy.alfred.backend.links.adapter.out.peer;

import java.nio.ByteBuffer;

/** One side of a link's WebSocket, whichever library holds it. Sends are serialized by the implementation. */
interface Wire {

    void text(String json);

    void binary(ByteBuffer data);

    void close(int code, String why);
}
