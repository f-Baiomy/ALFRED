package com.fathy.alfred.backend.links.application.port.in;

/** A relayed read in progress, on the reader: give the owner room for more chunks, or stop it. */
public interface RelayCall {

    void credit(int chunks);

    void cancel();
}
