package com.fathy.alfred.backend.sessions.domain.model;

import java.time.Instant;

/** One line of a board's audit (specs/031): what was written, by whom, from which PC and through what (a session or a browser). */
public record AuditEntry(long id, Instant at, String boardId, String what, String user, String machine, String via) {
}
