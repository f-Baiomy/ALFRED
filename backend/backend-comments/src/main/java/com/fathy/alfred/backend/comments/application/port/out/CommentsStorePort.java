package com.fathy.alfred.backend.comments.application.port.out;

import com.fathy.alfred.backend.comments.domain.model.Comment;

import java.util.List;

/** Outbound port: comment persistence, without the application core knowing it's a flat JSON file today. */
public interface CommentsStorePort {

    List<Comment> findAll();

    Comment save(Comment comment);

    /** @return true if a comment with this id existed and was deleted. */
    boolean deleteById(String id);
}
