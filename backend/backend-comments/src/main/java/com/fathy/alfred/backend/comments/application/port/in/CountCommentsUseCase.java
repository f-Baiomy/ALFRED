package com.fathy.alfred.backend.comments.application.port.in;

import com.fathy.alfred.backend.comments.domain.model.CommentCount;

import java.util.Collection;
import java.util.Map;

public interface CountCommentsUseCase {

    /** Counts for those of {@code callIds} that have comments; a call without any is absent, not zero. */
    Map<String, CommentCount> countByCallIds(Collection<String> callIds);
}
