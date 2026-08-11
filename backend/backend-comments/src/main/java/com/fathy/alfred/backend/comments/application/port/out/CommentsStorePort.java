package com.fathy.alfred.backend.comments.application.port.out;

import com.fathy.alfred.backend.comments.domain.model.Comment;

import java.util.List;

/** Outbound port: comment persistence, without the application core knowing it's a flat JSON file today. */
public interface CommentsStorePort {

    List<Comment> findAll();

    Comment save(Comment comment);

    /** @return true if a comment with this id existed and was deleted. */
    boolean deleteById(String id);

    /** Full overwrite - used by the one-time startup migration (backend-app) that remaps comments' callId from the legacy content-hash to a call's real id, not by any regular request-handling path. */
    void replaceAll(List<Comment> comments);
}
