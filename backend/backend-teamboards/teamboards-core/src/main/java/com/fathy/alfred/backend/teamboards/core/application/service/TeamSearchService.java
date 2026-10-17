package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.application.port.in.SavedSearchesUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException.Code;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamSearchUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamBoardsPort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort;
import com.fathy.alfred.backend.teamboards.core.application.service.Live.Ctx;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardBadge;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.CardLinkRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.FieldDiff;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemCopyRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemView;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Me;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.PersonRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SearchResult;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SearchRow;
import com.fathy.alfred.backend.teamboards.spi.AttachmentsReader;
import com.fathy.alfred.backend.teamboards.spi.ItemReader;
import com.fathy.alfred.backend.teamboards.spi.ItemSearcher;
import com.fathy.alfred.backend.teamboards.spi.QueryRunner;
import com.fathy.alfred.backend.teamboards.spi.RevisionsReader;
import com.fathy.alfred.backend.teamboards.spi.model.Attachment;
import com.fathy.alfred.backend.teamboards.spi.model.Comment;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.ItemPage;
import com.fathy.alfred.backend.teamboards.spi.model.ItemQuery;
import com.fathy.alfred.backend.teamboards.spi.model.Link;
import com.fathy.alfred.backend.teamboards.spi.model.Person;
import com.fathy.alfred.backend.teamboards.spi.model.Revision;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Live search and live reads (specs/028 US1). The answer is never written anywhere: the only lookups are Alfred's own
 * board links (badges) and the saved copy of an item a board keeps (its rev and the diff).
 */
@Service
public class TeamSearchService implements TeamSearchUseCase {

    private final Live live;
    private final TeamCachePort cache;
    private final TeamUseCase team;
    private final ObjectProvider<TeamBoardsPort> boards;
    private final ObjectProvider<SavedSearchesUseCase> saved;

    public TeamSearchService(Live live, TeamCachePort cache, TeamUseCase team, ObjectProvider<TeamBoardsPort> boards,
                             ObjectProvider<SavedSearchesUseCase> saved) {
        this.live = live;
        this.cache = cache;
        this.team = team;
        this.boards = boards;
        this.saved = saved;
    }

    static List<String> clean(List<String> in, int max) {
        if (in == null) {
            return List.of();
        }
        List<String> out = new ArrayList<>();
        for (String s : in) {
            if (s != null && !s.isBlank() && s.length() <= 300 && out.size() < max) {
                out.add(s.strip());
            }
        }
        return out;
    }

    /** The search with "me" resolved: the token's owner stays "me" (the tracker's own @Me); a "This is me" person by name. */
    ItemQuery query(String conn, SearchIn in) {
        if (in == null) {
            in = SearchIn.people(null, null, 50);
        }
        if (in.text() != null && in.text().length() > 500) {
            throw TeamException.invalid("Search text is at most 500 characters");
        }
        if (in.pageSize() > ItemQuery.MAX_PAGE_SIZE) {
            throw TeamException.invalid("A page holds at most " + ItemQuery.MAX_PAGE_SIZE + " items");
        }
        if (in.changedWithinDays() != null && (in.changedWithinDays() < 1 || in.changedWithinDays() > 3650)) {
            throw TeamException.invalid("changedWithinDays is 1 to 3650");
        }
        boolean wantsMe = hasMe(in.assigned()) || hasMe(in.createdBy()) || (in.mine() != null && !in.mine().isEmpty());
        String meName = null;
        if (wantsMe) {
            Optional<Me> me = team.me(conn);
            if (me.isEmpty()) {
                throw new TeamException(Code.TOKEN_MISSING, "\"Me\" is the token's owner: enter your token first");
            }
            if ("OVERRIDE".equals(me.get().source())) {
                PersonRow p = me.get().person();
                meName = p.email() != null && !p.email().isBlank() ? p.email() : p.name();
            }
        }
        String text = in.text() == null || in.text().isBlank() ? null : in.text().strip();
        List<String> parents = clean(in.parents(), 50);
        if (parents.stream().anyMatch(x -> !x.replace("#", "").matches("\\d{1,9}"))) {
            throw TeamException.invalid("Under parent takes item ids (numbers)");
        }
        if (in.childDepth() != null && in.childDepth() < 0) {
            throw TeamException.invalid("childDepth is 1 (one level) or 0 (every level)");
        }
        return new ItemQuery(text, clean(in.types(), 50), clean(in.states(), 50), in.openOnly() == null || in.openOnly(), clean(in.areas(), 50),
                Boolean.TRUE.equals(in.areaExact()), clean(in.teams(), 20), clean(in.iterations(), 20), clean(in.assigned(), 50),
                clean(in.createdBy(), 50), in.changedWithinDays(), clean(in.tags(), 20), Boolean.TRUE.equals(in.tagsAll()), parents, in.mine(), meName,
                in.sort(), in.page(), in.pageSize());
    }

    private static boolean hasMe(List<String> who) {
        return who != null && who.stream().anyMatch("me"::equalsIgnoreCase);
    }

    @Override
    public SearchResult search(String conn, SearchIn in) {
        Ctx c = live.ctx(conn);
        ItemQuery q = query(conn, in);
        ItemSearcher s = live.cap(c, ItemSearcher.class, "search");
        ItemPage page = live.call(c, () -> s.search(c.connection(), c.token(), q));
        if (in != null && in.saved() != null) {
            SavedSearchesUseCase saved = this.saved.getIfAvailable();
            if (saved != null) {
                saved.counted(in.saved(), page.total());
            }
        }
        Show show = in == null || in.show() == null ? Show.ITEMS : in.show();
        List<SearchRow> rows = rows(conn, page.items());
        if (show == Show.ITEMS || page.items().isEmpty()) {
            return new SearchResult(rows, page.total(), page.fullText(), q.page(), q.pageSize(), show.name(), List.of(), 0);
        }
        int depth = in.childDepth() != null && in.childDepth() == 0 ? MAX_HOPS : Math.max(1, in.childDepth() == null ? 1 : in.childDepth());
        Context ctx = context(c, page.items(), show == Show.TREE ? depth : 0);
        return new SearchResult(rows, page.total(), page.fullText(), q.page(), q.pageSize(), show.name(), rows(conn, ctx.items()), ctx.leftOut());
    }

    /** How far up (and, for every level, down) a tree is followed - deeper than any real backlog, short of a link loop. */
    static final int MAX_HOPS = 12;

    record Context(List<Item> items, int leftOut) {
    }

    /**
     * The parents of a page's matches up to the top, then (when {@code childDepth} > 0) their children that many levels
     * down - read live a level at a time, one batch each, never stored. At most {@link #MAX_CONTEXT} items; the rest
     * are counted, not read.
     */
    Context context(Ctx c, List<Item> matches, int childDepth) {
        Set<String> known = new LinkedHashSet<>();
        matches.forEach(i -> known.add(i.extId()));
        List<Item> extra = new ArrayList<>();
        int[] leftOut = {0};
        List<Item> level = matches;
        for (int hop = 0; hop < MAX_HOPS && !level.isEmpty(); hop++) {
            level = more(c, level, "Parent", known, extra, leftOut);
        }
        level = matches;
        for (int hop = 0; hop < childDepth && !level.isEmpty(); hop++) {
            level = more(c, level, "Child", known, extra, leftOut);
        }
        return new Context(extra, leftOut[0]);
    }

    private List<Item> more(Ctx c, List<Item> level, String kind, Set<String> known, List<Item> extra, int[] leftOut) {
        List<String> want = new ArrayList<>();
        for (Item i : level) {
            for (Link l : i.links()) {
                if (kind.equals(l.kind()) && l.toId() != null && !known.contains(l.toId()) && !want.contains(l.toId())) {
                    want.add(l.toId());
                }
            }
        }
        int room = MAX_CONTEXT - extra.size();
        if (want.size() > room) {
            leftOut[0] += want.size() - Math.max(0, room);
            want = want.subList(0, Math.max(0, room));
        }
        if (want.isEmpty()) {
            return List.of();
        }
        known.addAll(want); // an id the tracker hides is asked once, not again
        List<Item> got = live.items(c, want);
        extra.addAll(got);
        return got;
    }

    /** An item's parent id, when the tracker gave its relations. */
    static String parentOf(Item i) {
        return i.links().stream().filter(l -> "Parent".equals(l.kind())).map(Link::toId).findFirst().orElse(null);
    }

    @Override
    public SearchResult query(String conn, String query, int max) {
        if (query == null || query.isBlank() || query.length() > 32_000) {
            throw TeamException.invalid("A query is 1 to 32000 characters");
        }
        String head = query.strip().toUpperCase(Locale.ROOT);
        if (!head.startsWith("SELECT")) {
            throw TeamException.invalid("Only a SELECT query is run - nothing that writes");
        }
        int cap = Math.max(1, Math.min(max <= 0 ? MAX_ITEMS : max, MAX_ITEMS));
        Ctx c = live.ctx(conn);
        QueryRunner r = live.cap(c, QueryRunner.class, "run a query");
        List<Item> items = live.call(c, () -> r.query(c.connection(), c.token(), query.strip(), cap));
        return new SearchResult(rows(conn, items), items.size(), false, 0, items.size());
    }

    /** Rows for a page, each with its board badges and the cards linking it. */
    List<SearchRow> rows(String conn, List<Item> items) {
        List<String> ids = items.stream().map(Item::extId).toList();
        Map<String, List<BoardBadge>> badges = cache.badges(conn, ids);
        Map<String, String> names = new HashMap<>();
        List<SearchRow> out = new ArrayList<>();
        for (Item i : items) {
            List<BoardBadge> b = new ArrayList<>();
            for (BoardBadge x : badges.getOrDefault(i.extId(), List.of())) {
                b.add(x.with(names.computeIfAbsent(x.boardId(), this::boardName), x.copyRev() != null && i.rev() > x.copyRev()));
            }
            List<String> cards = cache.cardLinksOfItem(conn, i.extId()).stream().map(CardLinkRow::cardId).toList();
            out.add(new SearchRow(i.extId(), i.type(), i.title(), i.state(), live.category(conn, i.type(), i.state()), person(i), i.sprint(), i.area(),
                    i.changedAt(), i.rev(), i.url() == null ? null : i.url().toString(), b, cards, parentOf(i)));
        }
        return out;
    }

    static PersonRow person(Item i) {
        Person p = i.assignedPerson();
        if (p != null) {
            return new PersonRow(p.extId(), p.name(), p.email());
        }
        return i.assignee() == null ? null : new PersonRow(null, i.assignee(), null);
    }

    String boardName(String boardId) {
        TeamBoardsPort p = boards.getIfAvailable();
        return p == null ? boardId : p.boardName(boardId).orElse(boardId);
    }

    // ---------------------------------------------------------------------------------------------------------- items

    @Override
    public ItemView item(String conn, String id, Set<Part> include) {
        Ctx c = live.ctx(conn);
        if (id == null || id.isBlank() || id.length() > 100) {
            throw TeamException.invalid("An item id is 1 to 100 characters");
        }
        return view(c, live.item(c, id.strip()), include);
    }

    @Override
    public List<ItemView> items(String conn, List<String> ids, Set<Part> include) {
        if (ids == null || ids.isEmpty()) {
            return List.of();
        }
        if (ids.size() > MAX_ITEMS) {
            throw new TeamException(Code.TOO_MANY, "At most " + MAX_ITEMS + " items a call");
        }
        Ctx c = live.ctx(conn);
        List<ItemView> out = new ArrayList<>();
        for (Item i : live.items(c, ids)) {
            out.add(view(c, i, include));
        }
        return out;
    }

    ItemView view(Ctx c, Item item, Set<Part> include) {
        Set<Part> parts = include == null ? Set.of() : include;
        String conn = c.id();
        List<Comment> comments = null;
        if (parts.contains(Part.COMMENTS) && c.connector() instanceof ItemReader r) {
            comments = live.call(c, () -> r.comments(c.connection(), c.token(), item.extId()));
        }
        List<Revision> history = null;
        if (parts.contains(Part.HISTORY) && c.connector() instanceof RevisionsReader r) {
            history = live.call(c, () -> r.revisions(c.connection(), c.token(), item.extId()));
        }
        List<Attachment> attachments = null;
        if (parts.contains(Part.ATTACHMENTS) && c.connector() instanceof AttachmentsReader r) {
            attachments = r.listedIn(item);
        }
        Optional<ItemCopyRow> copy = cache.copy(conn, item.extId());
        List<Comment> nowComments = comments;
        List<FieldDiff> diff = copy.flatMap(Copies::item)
                .map(old -> ItemDiff.diff(old, nowComments == null ? null : Copies.comments(copy.get()), item, nowComments)).orElse(null);
        List<BoardBadge> badges = new ArrayList<>();
        for (BoardBadge b : cache.badges(conn, List.of(item.extId())).getOrDefault(item.extId(), List.of())) {
            badges.add(b.with(boardName(b.boardId()), b.copyRev() != null && item.rev() > b.copyRev()));
        }
        return new ItemView(Copies.lean(item), live.category(conn, item.type(), item.state()), comments, history, attachments,
                copy.map(ItemCopyRow::rev).orElse(null), copy.map(ItemCopyRow::savedAt).orElse(null), diff, badges,
                cache.cardLinksOfItem(conn, item.extId()));
    }

    @Override
    public FileBytes attachment(String conn, String id, String name) {
        Ctx c = live.ctx(conn);
        AttachmentsReader r = live.cap(c, AttachmentsReader.class, "read attachments");
        List<Attachment> all = live.call(c, () -> r.attachments(c.connection(), c.token(), id, false));
        Attachment a = all.stream().filter(x -> x.name().equals(name)).findFirst()
                .orElseThrow(() -> TeamException.notFound("Item " + id + " has no attachment " + name));
        if (a.size() > Attachment.MAX_BYTES) {
            throw new TeamException(Code.TOO_MANY, name + " is over 10 MB - open it in the tracker");
        }
        byte[] data = live.call(c, () -> r.content(c.connection(), c.token(), a));
        if (data == null) {
            throw TeamException.notFound(name + " could not be downloaded - open it in the tracker");
        }
        return new FileBytes(a.name(), a.mime(), data);
    }
}
