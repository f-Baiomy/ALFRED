package com.fathy.alfred.backend.dbcapture.application.port.in;

import com.fathy.alfred.backend.dbcapture.domain.model.CallStatementsPage;

/** A call's statements in order (paged by sequence), and the outside-any-call bucket. */
public interface GetCallStatementsUseCase {

    int MAX_LIMIT = 500;

    CallStatementsPage statements(String callId, int afterSeq, int limit);

    CallStatementsPage outside(String thread, int offset, int limit);
}
