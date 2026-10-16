package com.fathy.alfred.backend.board.application.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.application.port.in.SnippetsUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.application.port.out.SnippetStorePort;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CardChange.Outcome;
import com.fathy.alfred.backend.board.domain.model.Snippet;
import com.fathy.alfred.backend.board.domain.model.SnippetShot;
import com.fathy.alfred.backend.board.domain.model.SnippetState;
import com.fathy.alfred.backend.board.domain.model.SnippetVersion;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Pages, versions, saved state and shots (specs/017 R16, R23, R28-R32). Every change signals /ws/board ({@code pages}
 * for a page, {@code state:<snippetId>} for a value) so open pages re-read it - no polling.
 */
@Service
public class SnippetsService implements SnippetsUseCase {

    /** An inline block's id: where its text is (a card, a cycle's brief, a chat answer) and which html block of that text it is. */
    static final Pattern INLINE = Pattern.compile("^inline:(card|cycle|chat):([A-Za-z0-9-]{1,64}):([A-Za-z0-9-]{1,64}):(\\d{1,3})$");
    private static final Pattern PAGE_ID = Pattern.compile("^[A-Za-z0-9-]{8,64}$");
    private static final Pattern OWNER = Pattern.compile("^(card|cycle|project):(.{1,200})$");
    private static final String PNG_PREFIX = "data:image/png;base64,";

    private final SnippetStorePort store;
    private final BoardStorePort cards;
    private final BoardNotificationPort notifications;
    private final ObjectMapper json;
    private final Clock clock;

    @Autowired
    public SnippetsService(SnippetStorePort store, BoardStorePort cards, BoardNotificationPort notifications, ObjectMapper json) {
        this(store, cards, notifications, json, Clock.systemUTC());
    }

    SnippetsService(SnippetStorePort store, BoardStorePort cards, BoardNotificationPort notifications, ObjectMapper json, Clock clock) {
        this.store = store;
        this.cards = cards;
        this.notifications = notifications;
        this.json = json;
        this.clock = clock;
    }

    /** Where a page or an inline snippet belongs: its owner, project, card and cycle. */
    private record Place(Snippet.Owner owner, String ownerId, String project, String cardId, String cycleId) {
    }

    // ------------------------------------------------------------------------------------------------------------ pages

    @Override
    public Result<List<Snippet>> pages(String owner, String project) {
        Result<Place> place = place(owner, project);
        if (!place.isOk()) {
            return Result.refused(place.outcome(), place.message());
        }
        return Result.ok(store.list(place.value().owner(), place.value().ownerId()));
    }

    @Override
    public Result<Snippet> create(Actor actor, NewPage page) {
        Result<Place> where = place(page.owner(), page.project());
        if (!where.isOk()) {
            return Result.refused(where.outcome(), where.message());
        }
        Place p = where.value();
        Snippet.Kind kind = kind(page.kind());
        if (kind == null) {
            return Result.refused(Outcome.INVALID, "A page is HTML, MERMAID, PYTHON or BLOCK");
        }
        String name = page.name() == null ? "" : page.name().strip();
        String info = page.info() == null ? "" : page.info().strip();
        String source = page.source() == null ? "" : page.source();
        String problem = check(name, info, source);
        if (problem != null) {
            return Result.refused(Outcome.INVALID, problem);
        }
        List<Snippet> existing = store.list(p.owner(), p.ownerId());
        if (existing.size() >= Snippet.MAX_PER_OWNER) {
            return Result.refused(Outcome.INVALID, "At most " + Snippet.MAX_PER_OWNER + " pages in one place");
        }
        var now = clock.instant();
        Snippet s = new Snippet(UUID.randomUUID().toString(), p.owner(), p.ownerId(), p.project(), p.cardId(), p.cycleId(), name, kind, info,
                source, actor, false, existing.stream().mapToInt(Snippet::position).max().orElse(-1) + 1, 1, now, now, actor);
        store.insert(s);
        changed(s, "pages");
        return Result.ok(s);
    }

    @Override
    public Optional<Snippet> page(String id, Integer version) {
        if (id == null || !PAGE_ID.matcher(id).matches()) {
            return Optional.empty();
        }
        Optional<Snippet> s = store.find(id);
        if (s.isEmpty() || version == null || version == s.get().version()) {
            return s;
        }
        Snippet cur = s.get();
        return store.version(id, version).map(v -> new Snippet(cur.id(), cur.ownerType(), cur.ownerId(), cur.project(), cur.cardId(),
                cur.cycleId(), v.name(), cur.kind(), v.info(), v.source(), v.author(), cur.pinned(), cur.position(), v.version(),
                cur.createdAt(), v.at(), v.author()));
    }

    @Override
    public Result<Snippet> update(Actor actor, String id, PageEdit edit) {
        Optional<Snippet> found = page(id, null);
        if (found.isEmpty()) {
            return Result.refused(Outcome.NOT_FOUND, "No such page");
        }
        Snippet cur = found.get();
        if (actor == Actor.CLAUDE && cur.author() != Actor.CLAUDE) {
            return Result.refused(Outcome.REFUSED_FOR_CLAUDE, "Claude changes only the pages it created - suggest the change in a comment");
        }
        if (edit.baseVersion() != null && edit.baseVersion() != cur.version()) {
            return Result.refused(Outcome.CONFLICT, "The page was saved again (version " + cur.version() + ") since you opened version "
                    + edit.baseVersion() + " - reload it and save again");
        }
        String name = edit.name() == null ? cur.name() : edit.name().strip();
        String info = edit.info() == null ? cur.info() : edit.info().strip();
        String source = edit.source() == null ? cur.source() : edit.source();
        String problem = check(name, info, source);
        if (problem != null) {
            return Result.refused(Outcome.INVALID, problem);
        }
        boolean content = !name.equals(cur.name()) || !info.equals(cur.info()) || !source.equals(cur.source());
        boolean pinned = edit.pinned() == null ? cur.pinned() : edit.pinned();
        int position = edit.position() == null ? cur.position() : edit.position();
        if (!content && pinned == cur.pinned() && position == cur.position()) {
            return Result.ok(cur);
        }
        Snippet next = new Snippet(cur.id(), cur.ownerType(), cur.ownerId(), cur.project(), cur.cardId(), cur.cycleId(), name, cur.kind(), info,
                source, cur.author(), pinned, position, content ? cur.version() + 1 : cur.version(), cur.createdAt(), clock.instant(), actor);
        store.update(next, content);
        changed(next, "pages");
        return Result.ok(next);
    }

    @Override
    public Result<Void> delete(Actor actor, String id) {
        Optional<Snippet> found = page(id, null);
        if (found.isEmpty()) {
            return Result.refused(Outcome.NOT_FOUND, "No such page");
        }
        if (actor == Actor.CLAUDE && found.get().author() != Actor.CLAUDE) {
            return Result.refused(Outcome.REFUSED_FOR_CLAUDE, "Claude deletes only the pages it created");
        }
        store.delete(id);
        changed(found.get(), "pages");
        return Result.ok(null);
    }

    @Override
    public Result<List<SnippetVersion>> versions(String id) {
        return page(id, null).isEmpty() ? Result.refused(Outcome.NOT_FOUND, "No such page") : Result.ok(store.versions(id));
    }

    // ------------------------------------------------------------------------------------------------------------ state

    @Override
    public Result<List<SnippetState>> state(String snippetId) {
        Result<Place> p = snippetPlace(snippetId);
        return p.isOk() ? Result.ok(store.state(snippetId)) : Result.refused(p.outcome(), p.message());
    }

    @Override
    public Result<SnippetState> state(String snippetId, String key) {
        Result<Place> p = snippetPlace(snippetId);
        if (!p.isOk()) {
            return Result.refused(p.outcome(), p.message());
        }
        return store.state(snippetId, key).map(Result::ok).orElseGet(() -> Result.refused(Outcome.NOT_FOUND, "No value for " + key));
    }

    @Override
    public Result<SnippetState> putState(Actor actor, String snippetId, String key, String value) {
        Result<Place> where = snippetPlace(snippetId);
        if (!where.isOk()) {
            return Result.refused(where.outcome(), where.message());
        }
        if (key == null || key.isBlank() || key.length() > SnippetState.MAX_KEY) {
            return Result.refused(Outcome.INVALID, "A key is 1 to " + SnippetState.MAX_KEY + " characters");
        }
        Place p = where.value();
        if (value == null) {
            store.deleteState(snippetId, key);
            notifyState(p, snippetId);
            return Result.ok(null);
        }
        if (value.getBytes(StandardCharsets.UTF_8).length > SnippetState.MAX_VALUE_BYTES) {
            return Result.refused(Outcome.INVALID, "A saved value can be at most 64 KB");
        }
        try {
            json.readTree(value);
        } catch (Exception e) {
            return Result.refused(Outcome.INVALID, "A saved value is JSON");
        }
        if (store.state(snippetId, key).isEmpty() && store.state(snippetId).size() >= SnippetState.MAX_KEYS) {
            return Result.refused(Outcome.INVALID, "A snippet keeps at most " + SnippetState.MAX_KEYS + " values");
        }
        SnippetState s = new SnippetState(snippetId, key, value, actor, clock.instant());
        store.putState(s, p.cardId(), p.cycleId());
        notifyState(p, snippetId);
        return Result.ok(s);
    }

    @Override
    public Result<List<SnippetState>> stateHistory(String snippetId, String key) {
        Result<Place> p = snippetPlace(snippetId);
        return p.isOk() ? Result.ok(store.stateHistory(snippetId, key, SnippetState.HISTORY)) : Result.refused(p.outcome(), p.message());
    }

    // ------------------------------------------------------------------------------------------------------------ shots

    @Override
    public Result<Void> putShot(String snippetId, int version, String pngBase64, List<String> console) {
        Result<Place> where = snippetPlace(snippetId);
        if (!where.isOk()) {
            return Result.refused(where.outcome(), where.message());
        }
        byte[] png;
        try {
            String b64 = pngBase64 == null ? "" : pngBase64.startsWith(PNG_PREFIX) ? pngBase64.substring(PNG_PREFIX.length()) : pngBase64;
            png = Base64.getDecoder().decode(b64);
        } catch (IllegalArgumentException e) {
            return Result.refused(Outcome.INVALID, "The picture is not base64");
        }
        if (png.length < 8 || (png[0] & 0xff) != 0x89 || png[1] != 'P' || png[2] != 'N' || png[3] != 'G') {
            return Result.refused(Outcome.INVALID, "A shot is a PNG picture");
        }
        if (png.length > SnippetShot.MAX_PNG_BYTES) {
            return Result.refused(Outcome.INVALID, "A shot can be at most 5 MB");
        }
        String lines = String.join("\n", console == null ? List.of() : console);
        if (lines.length() > SnippetShot.MAX_CONSOLE) {
            lines = lines.substring(lines.length() - SnippetShot.MAX_CONSOLE);
        }
        Place p = where.value();
        store.putShot(new SnippetShot(snippetId, Math.max(0, version), png, lines, clock.instant()), p.cardId(), p.cycleId());
        return Result.ok(null);
    }

    @Override
    public Optional<SnippetShot> shot(String snippetId) {
        return snippetPlace(snippetId).isOk() ? store.shot(snippetId) : Optional.empty();
    }

    // ---------------------------------------------------------------------------------------------------------- helpers

    private Result<Place> place(String owner, String project) {
        Matcher m = owner == null ? null : OWNER.matcher(owner.strip());
        if (m == null || !m.matches()) {
            return Result.refused(Outcome.INVALID, "owner is card:<id>, cycle:<id> or project:<name>");
        }
        String id = m.group(2).strip();
        return switch (m.group(1)) {
            case "card" -> cards.find(id).map(c -> Result.ok(new Place(Snippet.Owner.CARD, c.id(), c.project(), c.id(), null)))
                    .orElseGet(() -> Result.refused(Outcome.NOT_FOUND, "No such card"));
            case "cycle" -> project == null || project.isBlank()
                    ? Result.refused(Outcome.INVALID, "A cycle's page needs its project")
                    : Result.ok(new Place(Snippet.Owner.CYCLE, id, project.strip(), null, id));
            default -> Result.ok(new Place(Snippet.Owner.PROJECT, id, id, null, null));
        };
    }

    /** A page by its id, or an inline block by where it is (its card must exist). */
    private Result<Place> snippetPlace(String snippetId) {
        if (snippetId == null) {
            return Result.refused(Outcome.NOT_FOUND, "No such snippet");
        }
        Matcher m = INLINE.matcher(snippetId);
        if (m.matches()) {
            if (m.group(1).equals("card")) {
                Optional<Card> c = cards.find(m.group(2));
                return c.map(card -> Result.ok(new Place(Snippet.Owner.CARD, card.id(), card.project(), card.id(), null)))
                        .orElseGet(() -> Result.refused(Outcome.NOT_FOUND, "No such card"));
            }
            if (m.group(1).equals("chat")) {
                // a block in a chat answer: its picture is kept by the message, belonging to no card or cycle
                return Result.ok(new Place(Snippet.Owner.PROJECT, "chat:" + m.group(2), null, null, null));
            }
            return Result.ok(new Place(Snippet.Owner.CYCLE, m.group(2), null, null, m.group(2)));
        }
        return page(snippetId, null).map(s -> Result.ok(new Place(s.ownerType(), s.ownerId(), s.project(), s.cardId(), s.cycleId())))
                .orElseGet(() -> Result.refused(Outcome.NOT_FOUND, "No such snippet"));
    }

    private static Snippet.Kind kind(String name) {
        try {
            return Snippet.Kind.valueOf((name == null || name.isBlank() ? "HTML" : name.strip()).toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static String check(String name, String info, String source) {
        if (name.isEmpty() || name.length() > Snippet.MAX_NAME) {
            return "A page needs a name of 1 to " + Snippet.MAX_NAME + " characters";
        }
        if (info.length() > Snippet.MAX_INFO) {
            return "The page's settings are at most " + Snippet.MAX_INFO + " characters";
        }
        if (source.getBytes(StandardCharsets.UTF_8).length > Snippet.MAX_SOURCE_BYTES) {
            return "A page can be at most 256 KB - load data with alfred.data() instead of pasting it";
        }
        return null;
    }

    @Override
    public Result<Visuals> visuals(String cardId, String cycleId, String project) {
        boolean card = cardId != null && !cardId.isBlank();
        boolean cycle = cycleId != null && !cycleId.isBlank();
        boolean whole = !card && !cycle && project != null;
        if ((card ? 1 : 0) + (cycle ? 1 : 0) + (whole ? 1 : 0) != 1) {
            return Result.refused(Outcome.INVALID, "Name one card, one cycle or a project");
        }
        Snippet.Owner owner = card ? Snippet.Owner.CARD : cycle ? Snippet.Owner.CYCLE : Snippet.Owner.PROJECT;
        String ownerId = card ? cardId.strip() : cycle ? cycleId.strip() : project.strip();
        List<PageWithVersions> pages = new java.util.ArrayList<>();
        for (Snippet listed : store.list(owner, ownerId)) {
            Snippet full = store.find(listed.id()).orElse(null);
            if (full == null) {
                continue;
            }
            List<SnippetVersion> versions = store.versions(full.id()).stream()
                    .map(v -> store.version(full.id(), v.version()).orElse(v)).toList();
            pages.add(new PageWithVersions(full, versions));
        }
        List<SnippetState> states;
        List<SnippetShot> shots;
        if (whole) {
            states = pages.stream().flatMap(p -> store.state(p.page().id()).stream()).toList();
            shots = pages.stream().flatMap(p -> store.shot(p.page().id()).stream()).toList();
        } else {
            states = store.statesOf(card ? cardId.strip() : null, card ? null : cycleId.strip());
            shots = store.shotsOf(card ? cardId.strip() : null, card ? null : cycleId.strip());
        }
        return Result.ok(new Visuals(pages, states, shots));
    }

    private void changed(Snippet s, String what) {
        notifications.changed(s.project(), s.cycleId(), s.cardId(), what);
    }

    private void notifyState(Place p, String snippetId) {
        notifications.changed(p.project(), p.cycleId(), p.cardId(), "state:" + snippetId);
    }
}
