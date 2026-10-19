package com.fathy.alfred.backend.links.application.port.out;

import com.fathy.alfred.backend.links.domain.model.LinkRequest;
import com.fathy.alfred.backend.links.domain.model.Stream;

import java.util.Optional;

/**
 * The owner's side of a request (backend-app/linksbridge): may this stream ask for it at all, and what it becomes once
 * accepted - written through the owner's own services as the user, with the other Alfred named as its author and a line
 * in the board's audit (D4). Never a new Actor value.
 */
public interface RequestApplyPort {

    /** The target's label when the stream covers it and allows the kind (COMMENT mode); empty when it does not. */
    Optional<String> allows(Stream stream, LinkRequest request);

    /** Makes the request real; returns the ref of what was made (a comment id), kept for Undo. */
    String apply(Stream stream, LinkRequest request, String authorName);

    /** Takes back what {@link #apply} made. */
    void undo(LinkRequest request);
}
