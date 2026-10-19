package com.fathy.alfred.backend.linksbridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.application.port.in.BoardImagesUseCase;
import com.fathy.alfred.backend.board.application.port.in.BoardOfUseCase;
import com.fathy.alfred.backend.board.application.port.in.ManageBoardsUseCase;
import com.fathy.alfred.backend.board.application.port.in.RelateCycleUseCase;
import com.fathy.alfred.backend.links.application.port.in.RelayUseCase;
import com.fathy.alfred.backend.links.application.port.out.SignalScopePort;
import com.fathy.alfred.backend.links.domain.RemoteRef;
import com.fathy.alfred.backend.links.domain.model.Stream;
import com.fathy.alfred.backend.links.domain.model.StreamKind;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListPagedCapturedInternalCallsUseCase;
import com.fathy.alfred.backend.triagebridge.CycleCallsReader;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * What a linked Alfred may read here (R2): a streamed cycle and its calls (with their statements, Redis commands, log
 * lines and notes); a streamed board, its cards, chat, brief, files and pictures, and every cycle on it with their calls.
 * Nothing else. A cycle on a streamed board that this Alfred itself reads from a third Alfred is passed on only by that
 * Alfred's own rule (D8) - here it only counts as "on the board". Also decides which of this Alfred's signals a reader
 * hears.
 */
@Component
public class StreamScope implements SignalScopePort {

    /** A cycle's call ids are read again after this long, or on its "content changed" signal. */
    static final long MEMBERS_TTL_MS = 15_000;

    private record Members(Set<String> ids, long at) {
    }

    private final ObjectProvider<RelateCycleUseCase> relations;
    private final ObjectProvider<BoardOfUseCase> boardOf;
    private final ObjectProvider<ManageBoardsUseCase> boards;
    private final ObjectProvider<BoardImagesUseCase> images;
    private final ObjectProvider<RelayUseCase> relay;
    private final CycleCallsReader reader;
    private final Map<String, Members> members = new ConcurrentHashMap<>();
    private static final long MIN_REREAD_MS = 1000;
    private final ObjectMapper json = new ObjectMapper();

    public StreamScope(ObjectProvider<RelateCycleUseCase> relations, ObjectProvider<BoardOfUseCase> boardOf, ObjectProvider<ManageBoardsUseCase> boards,
                       ObjectProvider<BoardImagesUseCase> images, ObjectProvider<RelayUseCase> relay, ListCapturedCallsUseCase capturedCalls,
                       ListPagedCapturedInternalCallsUseCase capturedInternalCalls) {
        this.relations = relations;
        this.boardOf = boardOf;
        this.boards = boards;
        this.images = images;
        this.relay = relay;
        this.reader = new CycleCallsReader(capturedCalls, capturedInternalCalls);
    }

    // --------------------------------------------------------------------------------------------- what is covered

    /** The cycles a link may read through {@code offered}: streamed cycles, and every cycle of a streamed board. */
    Set<String> cycles(List<Stream> offered) {
        Set<String> out = new LinkedHashSet<>();
        RelateCycleUseCase r = relations.getIfAvailable();
        for (Stream s : offered) {
            if (s.kind() == StreamKind.CYCLE) {
                out.add(s.target());
            } else if (r != null) {
                out.addAll(r.cyclesOfTask(s.target()));
            }
        }
        return out;
    }

    Set<String> boardIds(List<Stream> offered) {
        Set<String> out = new LinkedHashSet<>();
        for (Stream s : offered) {
            if (s.kind() == StreamKind.BOARD) {
                out.add(s.target());
            }
        }
        return out;
    }

    /** The stream that covers a cycle (the cycle's own first, then a board's). */
    Optional<Stream> streamOfCycle(List<Stream> offered, String cycleId) {
        for (Stream s : offered) {
            if (s.kind() == StreamKind.CYCLE && s.target().equals(cycleId)) {
                return Optional.of(s);
            }
        }
        RelateCycleUseCase r = relations.getIfAvailable();
        if (r == null) {
            return Optional.empty();
        }
        for (Stream s : offered) {
            if (s.kind() == StreamKind.BOARD && r.cyclesOfTask(s.target()).contains(cycleId)) {
                return Optional.of(s);
            }
        }
        return Optional.empty();
    }

    Optional<Stream> streamOfBoard(List<Stream> offered, String boardId) {
        return offered.stream().filter(s -> s.kind() == StreamKind.BOARD && s.target().equals(boardId)).findFirst();
    }

    /** The local cycle (covered by {@code offered}) a call belongs to, if any; {@code onlyCycles} narrows it (R6). */
    Optional<Stream> streamOfCall(List<Stream> offered, String callId, String cycleHint, Set<String> onlyCycles) {
        Optional<Stream> found = streamOfCall(offered, callId, cycleHint, onlyCycles, false);
        // a call captured since the membership was read is in none of the cached lists: read them again once - a
        // reader opens a new call the moment its signal arrives, and must not be refused for the cache's age
        return found.isPresent() ? found : streamOfCall(offered, callId, cycleHint, onlyCycles, true);
    }

    private Optional<Stream> streamOfCall(List<Stream> offered, String callId, String cycleHint, Set<String> onlyCycles, boolean fresh) {
        if (cycleHint != null) {
            if (onlyCycles != null && !onlyCycles.contains(cycleHint)) {
                return Optional.empty();
            }
            Optional<Stream> s = streamOfCycle(offered, cycleHint);
            return s.isPresent() && callIds(cycleHint, fresh).contains(callId) ? s : Optional.empty();
        }
        for (String cycle : cycles(offered)) {
            if (isRemote(cycle) || (onlyCycles != null && !onlyCycles.contains(cycle))) {
                continue;
            }
            if (callIds(cycle, fresh).contains(callId)) {
                return streamOfCycle(offered, cycle);
            }
        }
        return Optional.empty();
    }

    /** True when a value ends in the suffix of one of this Alfred's links (a third Alfred's thing). */
    boolean isRemote(String value) {
        RelayUseCase r = relay.getIfAvailable();
        return r != null && RemoteRef.outer(value).map(sp -> r.knows(sp.slug())).orElse(false);
    }

    /** A cycle's call ids (captured ids and the calls' own ids), cached briefly. */
    Set<String> callIds(String cycleId) {
        return callIds(cycleId, false);
    }

    /** {@code fresh}: read again unless the list is under a second old (a miss never re-reads more than once a second). */
    private Set<String> callIds(String cycleId, boolean fresh) {
        long now = System.currentTimeMillis();
        Members m = members.get(cycleId);
        if (m != null && now - m.at() < (fresh ? MIN_REREAD_MS : MEMBERS_TTL_MS)) {
            return m.ids();
        }
        Set<String> ids = new HashSet<>();
        try {
            reader.inbound(cycleId, c -> {
                ids.add(c.id());
                if (c.call() != null) {
                    ids.add(c.call().id());
                }
            });
            reader.outbound(cycleId, c -> {
                ids.add(c.id());
                if (c.call() != null) {
                    ids.add(c.call().id());
                }
            });
        } catch (RuntimeException e) {
            // an unknown cycle has no calls
        }
        members.put(cycleId, new Members(ids, now));
        return ids;
    }

    void forget(String cycleId) {
        if (cycleId == null) {
            members.clear();
        } else {
            members.remove(cycleId);
        }
    }

    Optional<String> boardOfCard(String cardId) {
        BoardOfUseCase b = boardOf.getIfAvailable();
        return b == null ? Optional.empty() : b.boardOfCard(cardId);
    }

    Optional<String> boardOfCardNumber(String project, int number) {
        BoardOfUseCase b = boardOf.getIfAvailable();
        return b == null || project == null ? Optional.empty() : b.boardOfCardNumber(project, number);
    }

    Optional<String> boardOfChat(String project, String scope) {
        BoardOfUseCase b = boardOf.getIfAvailable();
        return b == null || project == null ? Optional.empty() : Optional.ofNullable(b.boardOfChat(project, scope));
    }

    Optional<String> boardOfFile(String id) {
        BoardOfUseCase b = boardOf.getIfAvailable();
        return b == null ? Optional.empty() : b.boardOfFile(id);
    }

    Optional<String> boardOfSnippet(String id) {
        BoardOfUseCase b = boardOf.getIfAvailable();
        return b == null ? Optional.empty() : b.boardOfSnippet(id);
    }

    Optional<String> boardOfImage(String id) {
        BoardImagesUseCase i = images.getIfAvailable();
        if (i == null) {
            return Optional.empty();
        }
        return i.image(id).flatMap(img -> img.cardId() != null ? boardOfCard(img.cardId()) : Optional.ofNullable(img.cycleId()));
    }

    /** A board's project; the default board's id names it. */
    Optional<String> projectOf(String boardId) {
        if (boardId.startsWith("default:")) {
            return Optional.of(boardId.substring("default:".length()));
        }
        ManageBoardsUseCase b = boards.getIfAvailable();
        return b == null ? Optional.empty() : b.get(boardId).map(s -> s.board().project());
    }

    // ------------------------------------------------------------------------------------------------- signals

    @Override
    public boolean concerns(Stream stream, String channel, String text) {
        JsonNode m;
        try {
            m = json.readTree(text);
        } catch (Exception e) {
            return false;
        }
        String type = m.path("type").asText("");
        String cycleId = m.hasNonNull("cycleId") ? m.path("cycleId").asText() : null;
        String callId = m.hasNonNull("callId") ? m.path("callId").asText() : null;
        String cardId = m.hasNonNull("cardId") ? m.path("cardId").asText() : null;
        String project = m.hasNonNull("project") ? m.path("project").asText() : null;
        List<Stream> one = List.of(stream);
        switch (channel) {
            case "session-cycles" -> {
                if (cycleId != null) {
                    forget(cycleId);
                    return cycles(one).contains(cycleId);
                }
                forget(null);
                return "session-cycles-changed".equals(type);
            }
            case "board" -> {
                if (stream.kind() != StreamKind.BOARD || !("board-changed".equals(type) || "chat-changed".equals(type))) {
                    return false; // what Claude is doing here (live work, runners, agent status) is never streamed
                }
                if (cycleId != null && cycleId.equals(stream.target())) {
                    return true;
                }
                if (cardId != null && boardOfCard(cardId).map(stream.target()::equals).orElse(false)) {
                    return true;
                }
                return cycleId == null && project != null && projectOf(stream.target()).map(project::equals).orElse(false);
            }
            case "comments", "db-capture", "call-logs", "triage" -> {
                return callId != null && streamOfCall(one, callId, null, null).isPresent();
            }
            default -> {
                return false;
            }
        }
    }
}
