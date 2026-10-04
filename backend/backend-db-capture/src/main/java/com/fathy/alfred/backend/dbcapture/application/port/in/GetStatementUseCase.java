package com.fathy.alfred.backend.dbcapture.application.port.in;

import com.fathy.alfred.backend.dbcapture.domain.model.CapturedStatement;
import com.fathy.alfred.backend.dbcapture.domain.model.RowsPage;

import java.util.Optional;

/** One statement in full, and its rows a page at a time. */
public interface GetStatementUseCase {

    int MAX_ROWS = 1000;

    Optional<CapturedStatement> statement(long id);

    /** {@code part}: RESULT or BEFORE_IMAGE. Empty when the statement does not exist. */
    Optional<RowsPage> rows(long id, String part, int offset, int limit);
}
