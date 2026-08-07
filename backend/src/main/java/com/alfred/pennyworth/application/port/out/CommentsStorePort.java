package com.alfred.pennyworth.application.port.out;

import com.alfred.pennyworth.domain.model.Comment;

import java.util.List;

/** Outbound port: comment persistence, without the application core knowing it's a flat JSON file today. */
public interface CommentsStorePort {

    List<Comment> findAll();

    Comment save(Comment comment);

    /** @return true if a comment with this id existed and was deleted. */
    boolean deleteById(String id);
}
