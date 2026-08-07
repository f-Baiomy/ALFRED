package com.alfred.pennyworth.application.port.in;

public interface DeleteCommentUseCase {

    /** @return true if a comment with this id existed and was deleted. */
    boolean deleteById(String id);
}
