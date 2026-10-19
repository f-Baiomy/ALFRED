package com.fathy.alfred.backend.links.application.port.out;

import com.fathy.alfred.backend.links.application.port.in.RelayRequest;
import com.fathy.alfred.backend.links.application.port.in.ResponseWriter;
import com.fathy.alfred.backend.links.domain.model.Link;
import com.fathy.alfred.backend.links.domain.model.Stream;

import java.util.List;

/**
 * Answers a linked Alfred's read from this Alfred's own data (backend-app/linksbridge): finds the stream that allows it
 * (R2 - no stream, no answer), answers through the existing routes, masks secrets unless the stream says otherwise
 * (D17, D28), and passes a read for a third Alfred on when the far owner allows it (D8, R6).
 */
public interface LocalDispatchPort {

    void serve(Link from, List<Stream> offered, RelayRequest request, ResponseWriter writer);
}
