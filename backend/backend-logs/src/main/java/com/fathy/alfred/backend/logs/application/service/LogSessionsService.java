package com.fathy.alfred.backend.logs.application.service;

import com.fathy.alfred.backend.logs.application.port.in.LogsException;
import com.fathy.alfred.backend.logs.application.port.in.RecordLogSessionsUseCase;
import com.fathy.alfred.backend.logs.application.port.out.LogLineStorePort;
import com.fathy.alfred.backend.logs.application.port.out.LogNotificationPort;
import com.fathy.alfred.backend.logs.application.port.out.LogSessionStorePort;
import com.fathy.alfred.backend.logs.application.port.out.LogSourceStorePort;
import com.fathy.alfred.backend.logs.domain.model.FieldDef;
import com.fathy.alfred.backend.logs.domain.model.LogQuery;
import com.fathy.alfred.backend.logs.domain.model.LogSession;
import com.fathy.alfred.backend.logs.domain.model.LogStructure;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * Session recordings. A session is a stretch of arrival time on one source - optionally narrowed by a
 * filter, or by one value of one ID field - turned into explorer pills, so opening it is an ordinary
 * search. Reading never stops while recording; stopping pins the session's lines (kept forever).
 */
@Service
public class LogSessionsService implements RecordLogSessionsUseCase {

    static final int MAX_NAME = 120;
    static final int MAX_NOTES = 4_000;
    static final int MAX_MARKERS = 500;
    static final int MAX_MARKER = 200;

    private final LogSourceStorePort sources;
    private final LogSessionStorePort sessions;
    private final LogLineStorePort lines;
    private final LogNotificationPort notifications;

    public LogSessionsService(LogSourceStorePort sources, LogSessionStorePort sessions, LogLineStorePort lines,
                              LogNotificationPort notifications) {
        this.sources = sources;
        this.sessions = sessions;
        this.lines = lines;
        this.notifications = notifications;
    }

    private LogStructure structure(String sourceId) {
        sources.get(sourceId).orElseThrow(() -> LogsException.notFound("Log source"));
        return sources.structure(sourceId).orElseThrow(() -> LogsException.notFound("Structure"));
    }

    private LogSession find(String sourceId, String sessionId) {
        return sessions.get(sessionId).filter(s -> s.sourceId().equals(sourceId)).orElseThrow(() -> LogsException.notFound("Session"));
    }

    /** The pills that select exactly this session's lines (a recording session runs to "now"). */
    static List<LogQuery.Pill> pills(LogSession s) {
        List<LogQuery.Pill> out = new ArrayList<>();
        out.add(new LogQuery.Pill(LogQuery.Op.INGESTED, null, null, String.valueOf(s.startedAt()),
                s.endedAt() == null ? null : String.valueOf(s.endedAt()), null));
        if (s.kind() == LogSession.Kind.ID) {
            out.add(new LogQuery.Pill(LogQuery.Op.EQ, s.idField(), s.idValue(), null, null, null));
        } else if (s.pills() != null) {
            out.addAll(s.pills());
        }
        return out;
    }

    private SessionView view(LogSession s) {
        if (!s.recording()) {
            return new SessionView(s, pills(s));
        }
        // Still recording: live counts.
        LogStructure st = structure(s.sourceId());
        LogQuery q = new LogQuery(pills(s), null, null, null, null, 0).normalized();
        LogSession live = new LogSession(s.id(), s.sourceId(), s.name(), s.notes(), s.kind(), s.pills(), s.idField(), s.idValue(),
                s.startedAt(), null, s.markers(), lines.countMatching(s.sourceId(), st, q), lines.countErrors(s.sourceId(), st, q), s.createdAt());
        return new SessionView(live, pills(live));
    }

    @Override
    public List<SessionView> sessions(String sourceId) {
        structure(sourceId);
        return sessions.bySource(sourceId).stream().map(this::view).toList();
    }

    @Override
    public SessionView session(String sourceId, String sessionId) {
        return view(find(sourceId, sessionId));
    }

    private static String name(String name) {
        String n = name == null ? "" : name.strip();
        if (n.isEmpty() || n.length() > MAX_NAME) {
            throw LogsException.bad("A session name is 1-" + MAX_NAME + " characters");
        }
        return n;
    }

    @Override
    public SessionView start(String sourceId, String name, LogSession.Kind kind, List<LogQuery.Pill> pills, String idField, String idValue) {
        LogStructure s = structure(sourceId);
        LogSession.Kind k = kind == null ? LogSession.Kind.WINDOW : kind;
        List<LogQuery.Pill> filter = k == LogSession.Kind.WINDOW && pills != null ? List.copyOf(pills) : List.of();
        if (filter.size() > LogQuery.MAX_PILLS) {
            throw LogsException.bad("At most " + LogQuery.MAX_PILLS + " filters");
        }
        if (filter.stream().anyMatch(p -> p.op() == LogQuery.Op.SELECTION || p.op() == LogQuery.Op.INGESTED)) {
            throw LogsException.bad("A session filter cannot hold a selection or another time window");
        }
        if (k == LogSession.Kind.ID) {
            FieldDef f = s.byLabel(idField == null ? "" : idField).filter(FieldDef::stored)
                    .orElseThrow(() -> LogsException.bad("Choose the ID field to record"));
            if (idValue == null || idValue.isBlank() || idValue.length() > 500) {
                throw LogsException.bad("Enter the " + f.label() + " to record");
            }
        }
        LogSession session = new LogSession(LogSourcesService.id("r", 6), sourceId, name(name), "", k, filter,
                k == LogSession.Kind.ID ? idField : null, k == LogSession.Kind.ID ? idValue.strip() : null,
                System.currentTimeMillis(), null, List.of(), 0, 0, Instant.now().toString());
        sessions.save(session);
        notifications.sessionsChanged(sourceId);
        return view(session);
    }

    @Override
    public SessionView mark(String sourceId, String sessionId, String text) {
        LogSession s = find(sourceId, sessionId);
        String t = text == null ? "" : text.strip();
        if (t.isEmpty() || t.length() > MAX_MARKER) {
            throw LogsException.bad("A marker is 1-" + MAX_MARKER + " characters");
        }
        if (s.markers().size() >= MAX_MARKERS) {
            throw LogsException.bad("At most " + MAX_MARKERS + " markers per session");
        }
        List<LogSession.Marker> markers = new ArrayList<>(s.markers());
        long at = s.recording() ? System.currentTimeMillis() : s.endedAt();
        markers.add(new LogSession.Marker(at, t));
        LogSession updated = new LogSession(s.id(), s.sourceId(), s.name(), s.notes(), s.kind(), s.pills(), s.idField(), s.idValue(),
                s.startedAt(), s.endedAt(), markers, s.lineCount(), s.errorCount(), s.createdAt());
        sessions.save(updated);
        notifications.sessionsChanged(sourceId);
        return view(updated);
    }

    @Override
    public SessionView stop(String sourceId, String sessionId) {
        LogSession s = find(sourceId, sessionId);
        if (!s.recording()) {
            return view(s);
        }
        LogStructure st = structure(sourceId);
        LogSession ended = new LogSession(s.id(), s.sourceId(), s.name(), s.notes(), s.kind(), s.pills(), s.idField(), s.idValue(),
                s.startedAt(), System.currentTimeMillis(), s.markers(), 0, 0, s.createdAt());
        LogQuery q = new LogQuery(pills(ended), null, null, null, null, 0).normalized();
        lines.pin(sourceId, st, q); // a recorded session keeps its lines forever
        LogSession counted = new LogSession(ended.id(), ended.sourceId(), ended.name(), ended.notes(), ended.kind(), ended.pills(),
                ended.idField(), ended.idValue(), ended.startedAt(), ended.endedAt(), ended.markers(),
                lines.countMatching(sourceId, st, q), lines.countErrors(sourceId, st, q), ended.createdAt());
        sessions.save(counted);
        notifications.sessionsChanged(sourceId);
        return view(counted);
    }

    @Override
    public SessionView update(String sourceId, String sessionId, String name, String notes) {
        LogSession s = find(sourceId, sessionId);
        String n = name == null ? s.name() : name(name);
        String no = notes == null ? s.notes() : notes;
        if (no.length() > MAX_NOTES) {
            throw LogsException.bad("Notes are at most " + MAX_NOTES + " characters");
        }
        LogSession updated = new LogSession(s.id(), s.sourceId(), n, no, s.kind(), s.pills(), s.idField(), s.idValue(), s.startedAt(),
                s.endedAt(), s.markers(), s.lineCount(), s.errorCount(), s.createdAt());
        sessions.save(updated);
        notifications.sessionsChanged(sourceId);
        return view(updated);
    }

    @Override
    public void delete(String sourceId, String sessionId) {
        find(sourceId, sessionId);
        sessions.delete(sessionId);
        notifications.sessionsChanged(sourceId);
    }
}
