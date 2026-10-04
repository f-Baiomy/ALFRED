package com.fathy.alfred.backend.logs.application.port.in;

import com.fathy.alfred.backend.logs.domain.model.LogQuery;
import com.fathy.alfred.backend.logs.domain.model.LogSession;

import java.util.List;

/** Recording sessions of a live log: start, mark, stop, then reopen them like a saved view that keeps its lines. */
public interface RecordLogSessionsUseCase {

    /**
     * @param pills the explorer filter that shows exactly this session's lines (what "Open" applies)
     */
    record SessionView(LogSession session, List<LogQuery.Pill> pills) {
    }

    List<SessionView> sessions(String sourceId);

    SessionView session(String sourceId, String sessionId);

    /**
     * @param pills   WINDOW: optional filter
     * @param idField ID: the field label; idValue its value
     */
    SessionView start(String sourceId, String name, LogSession.Kind kind, List<LogQuery.Pill> pills, String idField, String idValue);

    SessionView mark(String sourceId, String sessionId, String text);

    /** Ends the recording: its lines are counted and pinned (kept forever). */
    SessionView stop(String sourceId, String sessionId);

    SessionView update(String sourceId, String sessionId, String name, String notes);

    /** Removes the session; its lines stay (still pinned). */
    void delete(String sourceId, String sessionId);
}
