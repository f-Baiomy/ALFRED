package com.fathy.alfred.backend.server.application.port.in;

import com.fathy.alfred.backend.server.domain.model.EditAccess;

import java.util.Set;

/** Whether a request may change server settings or restart Alfred (FR-050..054). */
public interface EditAccessUseCase {

    /**
     * @param peerAddress the TCP peer of the request (never a forwarded-for header)
     * @param headerNames the names of the request's headers
     */
    EditAccess access(String peerAddress, Set<String> headerNames);
}
