package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.teamboards.core.application.port.in.LinksUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamBoardsPort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort.PendingFile;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort.StartRow;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort.StoredConnection;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamChangeSignalPort;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardLinkRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemSummary;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.RevisionRow;
import com.fathy.alfred.backend.teamboards.spi.AttachmentsReader;
import com.fathy.alfred.backend.teamboards.spi.Connector;
import com.fathy.alfred.backend.teamboards.spi.ProviderException;
import com.fathy.alfred.backend.teamboards.spi.model.Attachment;
import com.fathy.alfred.backend.teamboards.spi.model.FieldChange;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.Token;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/**
 * Board links (specs/027 US8/US9): set by /alfred-setup, with a snapshot of the item as it was then; "changed since setup"
 * is the snapshot against the item as cached now (who and when from the cached history when it has them).
 */
@Service
public class LinksService implements LinksUseCase {

    private static final ObjectMapper JSON = new ObjectMapper();
    /** The neutral fields a snapshot keeps beside the item's own. */
    static final List<String> NEUTRAL = List.of("title", "state", "type", "assignee", "squad", "sprint", "area", "url");

    private final Map<String, Connector> connectors;
    private final TeamCachePort cache;
    private final TeamChangeSignalPort signals;
    private final ObjectProvider<TeamBoardsPort> boards;

    @Autowired
    public LinksService(List<Connector> connectors, TeamCachePort cache, TeamChangeSignalPort signals, ObjectProvider<TeamBoardsPort> boards) {
        this.connectors = CachedItems.byKind(connectors);
        this.cache = cache;
        this.signals = signals;
        this.boards = boards;
    }

    /** The item as cached now: the neutral fields, then every field by its reference name. */
    Map<String, String> snapshot(String conn, ItemSummary s) {
        Map<String, String> out = new LinkedHashMap<>();
        String[] v = {s.title(), s.state(), s.type(), s.assignee(), s.squad(), s.sprint(), s.area(), s.url()};
        for (int i = 0; i < NEUTRAL.size(); i++) {
            if (v[i] != null) {
                out.put(NEUTRAL.get(i), v[i]);
            }
        }
        out.put("rev", String.valueOf(s.rev()));
        out.putAll(CachedItems.present(cache.fields(conn, s.extId())));
        return out;
    }

    private static String write(Map<String, String> m) {
        try {
            return JSON.writeValueAsString(m);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    private static Map<String, String> read(String json) {
        try {
            return JSON.readValue(json == null ? "{}" : json, new TypeReference<LinkedHashMap<String, String>>() { });
        } catch (JsonProcessingException e) {
            return new LinkedHashMap<>();
        }
    }

    @Override
    public LinkResult link(String board, String conn, String extId) {
        TeamBoardsPort port = boards.getIfAvailable();
        if (port == null || port.projectOf(board).isEmpty()) {
            return LinkResult.of(LinkOutcome.NOT_FOUND, "No board " + board);
        }
        Optional<ItemSummary> s = cache.summary(conn, extId);
        if (s.isEmpty()) {
            return LinkResult.of(LinkOutcome.NOT_FOUND, "Item " + extId + " is not in the cache yet: Refresh the Team tab first");
        }
        Optional<BoardLinkRow> other = cache.linkOfItem(conn, extId).filter(l -> !l.alfredBoard().equals(board));
        if (other.isPresent()) {
            return LinkResult.of(LinkOutcome.ALREADY_LINKED, "Item " + extId + " already has board " + other.get().alfredBoard());
        }
        Optional<BoardLinkRow> mine = cache.link(board).filter(l -> !(l.conn().equals(conn) && l.extId().equals(extId)));
        if (mine.isPresent()) {
            return LinkResult.of(LinkOutcome.ALREADY_LINKED, "Board " + board + " is already linked to item " + mine.get().extId());
        }
        cache.putLink(new BoardLinkRow(board, conn, extId, write(snapshot(conn, s.get())), s.get().rev()));
        cache.start(conn, extId).ifPresent(r -> cache.putStart(new StartRow(r.conn(), r.extId(), r.target(), r.chatMessageId(), StartService.DONE, r.at())));
        List<String> attached = new ArrayList<>();
        List<String> notAttached = new ArrayList<>();
        Set<String> held = port.files(board);
        for (PendingFile f : cache.takePending(conn, extId)) {
            if (held.contains(f.name())) {
                continue;
            }
            String why = port.attach(board, f.name(), f.data());
            if (why == null) attached.add(f.name()); else notAttached.add(f.name() + " (" + why + ")");
        }
        signals.changed(conn, "start");
        return new LinkResult(LinkOutcome.OK, null, attached, notAttached);
    }

    @Override
    public Optional<LinkView> linkOf(String board) {
        Optional<BoardLinkRow> found = cache.link(board);
        if (found.isEmpty()) {
            return Optional.empty();
        }
        BoardLinkRow l = found.get();
        Map<String, String> then = read(l.snapshotJson());
        Optional<ItemSummary> now = cache.summary(l.conn(), l.extId());
        List<FieldChangeRow> changes = now.map(s -> changes(l, then, snapshot(l.conn(), s))).orElse(List.of());
        String provider = cache.connection(l.conn()).map(c -> connectors.containsKey(c.kind()) ? connectors.get(c.kind()).displayName() : c.kind())
                .orElse("");
        Map<String, String> chip = new LinkedHashMap<>();
        Map<String, String> current = now.map(s -> snapshot(l.conn(), s)).orElse(then);
        for (String k : NEUTRAL) {
            if (current.get(k) != null) {
                chip.put(k, current.get(k));
            }
        }
        return Optional.of(new LinkView(board, l.conn(), l.extId(), provider, chip, changes, attachments(l)));
    }

    /** Every field whose value differs from the snapshot; who and when from the newest cached revision that changed it. */
    List<FieldChangeRow> changes(BoardLinkRow l, Map<String, String> then, Map<String, String> now) {
        List<RevisionRow> revs = cache.revisions(l.conn(), l.extId());
        List<FieldChangeRow> out = new ArrayList<>();
        Set<String> keys = new java.util.LinkedHashSet<>(then.keySet());
        keys.addAll(now.keySet());
        keys.remove("rev");
        for (String k : keys) {
            String a = then.get(k);
            String b = now.get(k);
            if (Objects.equals(a, b)) {
                continue;
            }
            String by = null;
            String at = null;
            for (RevisionRow r : revs) {
                if (r.rev() <= l.seenRev()) {
                    continue;
                }
                for (FieldChange f : r.changes()) {
                    if (f.field().equals(k) || (NEUTRAL.contains(k) && f.field().toLowerCase(java.util.Locale.ROOT).endsWith("." + k))) {
                        if (at == null || (r.at() != null && r.at().toString().compareTo(at) > 0)) {
                            by = r.by();
                            at = r.at() == null ? null : r.at().toString();
                        }
                    }
                }
            }
            out.add(new FieldChangeRow(k, a, b, by, at));
        }
        return out;
    }

    /** The attachments the cached item names, each marked held when the board has a file of that name. */
    List<AttachmentRef> attachments(BoardLinkRow l) {
        Optional<StoredConnection> c = cache.connection(l.conn());
        if (c.isEmpty() || !(connectors.get(c.get().kind()) instanceof AttachmentsReader r)) {
            return List.of();
        }
        Optional<Item> item = CachedItems.item(cache, l.conn(), l.extId());
        if (item.isEmpty()) {
            return List.of();
        }
        TeamBoardsPort port = boards.getIfAvailable();
        Set<String> held = port == null ? Set.of() : port.files(l.alfredBoard());
        return r.listedIn(item.get()).stream().map(a -> new AttachmentRef(a.name(), a.size(), String.valueOf(a.url()), held.contains(a.name()))).toList();
    }

    @Override
    public boolean seen(String board) {
        Optional<BoardLinkRow> found = cache.link(board);
        if (found.isEmpty()) {
            return false;
        }
        BoardLinkRow l = found.get();
        Optional<ItemSummary> s = cache.summary(l.conn(), l.extId());
        if (s.isPresent()) {
            cache.putLink(new BoardLinkRow(board, l.conn(), l.extId(), write(snapshot(l.conn(), s.get())), s.get().rev()));
        } else {
            cache.markLinkSeen(board, l.seenRev());
        }
        signals.changed(l.conn(), "start");
        return true;
    }

    @Override
    public boolean unlink(String board) {
        Optional<BoardLinkRow> found = cache.link(board);
        if (found.isEmpty()) {
            return false;
        }
        cache.deleteLink(board);
        cache.deleteStart(found.get().conn(), found.get().extId());
        signals.changed(found.get().conn(), "start");
        return true;
    }

    @Override
    public LinkResult fetchAttachments(String board, Token token) {
        if (token == null || token.blank()) {
            return LinkResult.of(LinkOutcome.TOKEN_MISSING, "Add your personal access token first");
        }
        Optional<BoardLinkRow> found = cache.link(board);
        TeamBoardsPort port = boards.getIfAvailable();
        if (found.isEmpty() || port == null) {
            return LinkResult.of(LinkOutcome.NOT_FOUND, "Board " + board + " is not linked to a work item");
        }
        BoardLinkRow l = found.get();
        Optional<StoredConnection> c = cache.connection(l.conn());
        if (c.isEmpty() || !(connectors.get(c.get().kind()) instanceof AttachmentsReader r)) {
            return LinkResult.of(LinkOutcome.INVALID, "This tracker gives no attachments");
        }
        try {
            Set<String> held = port.files(board);
            List<String> attached = new ArrayList<>();
            List<String> notAttached = new ArrayList<>();
            for (Attachment a : r.attachments(CachedItems.connection(c.get()), token, l.extId(), true)) {
                if (held.contains(a.name())) {
                    continue;
                }
                if (a.data() == null) {
                    notAttached.add(a.name() + " (over the size limit - open it in the tracker)");
                    continue;
                }
                String why = port.attach(board, a.name(), a.data());
                if (why == null) attached.add(a.name()); else notAttached.add(a.name() + " (" + why + ")");
            }
            return new LinkResult(LinkOutcome.OK, null, attached, notAttached);
        } catch (ProviderException e) {
            return switch (e.kind()) {
                case TOKEN_REJECTED -> LinkResult.of(LinkOutcome.TOKEN_REJECTED, "The provider refused the token - it may have expired");
                case NOT_FOUND -> LinkResult.of(LinkOutcome.NOT_FOUND, e.getMessage());
                default -> LinkResult.of(LinkOutcome.UNREACHABLE, e.getMessage());
            };
        }
    }
}
