package com.fathy.alfred.backend.server.application.port.out;

/** "Something about the server changed" (settings saved, .env edited, a process changed state): clients re-fetch. */
public interface ServerEventsPort {

    void serverChanged(String what);
}
