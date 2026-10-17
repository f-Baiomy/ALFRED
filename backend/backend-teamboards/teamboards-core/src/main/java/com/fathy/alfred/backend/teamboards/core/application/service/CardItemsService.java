package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.application.port.in.AzureWritesUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.AzureWritesUseCase.NewBundle;
import com.fathy.alfred.backend.teamboards.core.application.port.in.BoardItemsUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.CardItemsUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamBoardsPort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamBoardsPort.CardInfo;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort.HookRow;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamChangeSignalPort;
import com.fathy.alfred.backend.teamboards.core.application.service.Live.Ctx;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.CardItem;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.CardLinkRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemCopyRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.StepKind;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SyncRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WriteBundle;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WriteStep;
import com.fathy.alfred.backend.teamboards.spi.ItemReader;
import com.fathy.alfred.backend.teamboards.spi.model.Comment;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.NewItem;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Cards and tracker items, many to many (specs/028 US3). The Alfred side of a user's link happens at once; whatever
 * goes to the tracker - markers, a created item, a cleanup - is a bundle the user approves.
 */
@Service
public class CardItemsService implements CardItemsUseCase {

    private final Live live;
    private final TeamCachePort cache;
    private final TeamChangeSignalPort signals;
    private final ObjectProvider<TeamBoardsPort> boards;
    private final ObjectProvider<AzureWritesUseCase> writes;
    private final ObjectProvider<BoardItemsUseCase> boardItems;
    private final Clock clock = Clock.systemUTC();

    public CardItemsService(Live live, TeamCachePort cache, TeamChangeSignalPort signals, ObjectProvider<TeamBoardsPort> boards,
                            ObjectProvider<AzureWritesUseCase> writes, ObjectProvider<BoardItemsUseCase> boardItems) {
        this.live = live;
        this.cache = cache;
        this.signals = signals;
        this.boards = boards;
        this.writes = writes;
        this.boardItems = boardItems;
    }

    private TeamBoardsPort port() {
        TeamBoardsPort p = boards.getIfAvailable();
        if (p == null) {
            throw TeamException.notFound("Boards are not wired in this Alfred");
        }
        return p;
    }

    private CardInfo card(String cardId) {
        return port().card(cardId).orElseThrow(() -> TeamException.notFound("No card " + cardId));
    }

    private AzureWritesUseCase writes() {
        AzureWritesUseCase w = writes.getIfAvailable();
        if (w == null) {
            throw TeamException.notFound("Writes are not wired in this Alfred");
        }
        return w;
    }

    @Override
    public List<CardItem> items(String cardId) {
        List<CardItem> out = new ArrayList<>();
        for (CardLinkRow l : cache.cardLinks(cardId)) {
            Optional<ItemCopyRow> copy = cache.copy(l.conn(), l.item());
            Optional<Item> item = copy.flatMap(Copies::item);
            List<SyncRow> last = cache.syncs(l.conn(), l.item(), 1);
            boolean changed = !last.isEmpty() && !last.get(0).kept();
            // what Azure says now when a sync saw it; else the copy
            String state = item.map(Item::state).orElse(null);
            if (changed) {
                for (var d : last.get(0).diff()) {
                    if (d.field().endsWith("System.State") || d.field().equals("state")) {
                        state = d.to();
                    }
                }
            }
            String type = item.map(Item::type).orElse(null);
            String category = live.category(l.conn(), type, state);
            out.add(new CardItem(l.conn(), l.item(), type, item.map(Item::title).orElse("Item " + l.item()), state, category,
                    item.map(Item::changedBy).orElse(null), item.map(Item::changedAt).orElse(null), copy.map(ItemCopyRow::rev).orElse(0), changed,
                    Live.closed(category), Copies.comments(copy.orElse(null)), item.map(i -> i.url() == null ? null : i.url().toString()).orElse(null)));
        }
        return out;
    }

    @Override
    public LinkResult link(Who who, String cardId, String conn, String item, Markers markers, String askedIn) {
        CardInfo card = card(cardId);
        String id = BoardItemsService.idOf(item);
        live.stored(conn);
        if (cache.cardLinks(cardId).stream().anyMatch(l -> l.conn().equals(conn) && l.item().equals(id))) {
            throw TeamException.invalid("Card #" + card.number() + " already links item " + id);
        }
        List<WriteStep> steps = new ArrayList<>();
        if (who == Who.CLAUDE) {
            steps.add(new WriteStep(StepKind.LINK_ALFRED, Map.of("card", cardId), true, false, null));
        }
        steps.addAll(markerSteps(card, markers == null ? Markers.NONE : markers));
        List<CardItem> items = who == Who.USER ? linkInAlfred(cardId, conn, id, "user") : items(cardId);
        WriteBundle bundle = null;
        if (!steps.isEmpty()) {
            bundle = writes().create(who, new NewBundle(card.boardId(), cardId, conn, id,
                    (who == Who.CLAUDE ? "Link item " + id + " to card #" : "Mark item " + id + " as linked to card #") + card.number(), steps, askedIn,
                    null));
        }
        return new LinkResult(items, bundle);
    }

    /** The markers a link may write in the tracker (each needs the user's approval, FR-052). */
    List<WriteStep> markerSteps(CardInfo card, Markers m) {
        List<WriteStep> steps = new ArrayList<>();
        String address = publicAddress();
        if (m.hyperlink() && address != null) {
            steps.add(new WriteStep(StepKind.HYPERLINK, Map.of("url", address + "/board?board=" + enc(card.boardId()) + "&card=" + enc(card.id()),
                    "label", "Alfred card #" + card.number()), true, false, null));
        }
        if (m.comment()) {
            steps.add(new WriteStep(StepKind.COMMENT, Map.of("text", "Followed in Alfred as card #" + card.number() + ": " + card.title(), "marker",
                    "comment"), true, false, null));
        }
        if (m.tag()) {
            steps.add(new WriteStep(StepKind.TAG, Map.of("tag", "alfred"), true, false, null));
        }
        return steps;
    }

    private String publicAddress() {
        for (var c : cache.connections()) {
            Optional<String> a = cache.hook(c.id()).map(HookRow::publicAddress).filter(x -> x != null && !x.isBlank());
            if (a.isPresent()) {
                return a.get().replaceAll("/+$", "");
            }
        }
        return null;
    }

    private static String enc(String s) {
        return java.net.URLEncoder.encode(s == null ? "" : s, java.nio.charset.StandardCharsets.UTF_8);
    }

    @Override
    public List<CardItem> linkInAlfred(String cardId, String conn, String item, String by) {
        CardInfo card = card(cardId);
        Ctx c = live.ctx(conn);
        Item i = live.item(c, item);
        List<Comment> comments = c.connector() instanceof ItemReader r ? live.call(c, () -> r.comments(c.connection(), c.token(), i.extId())) : List.of();
        cache.putCopy(Copies.row(conn, i, comments, clock.instant()));
        boolean added = cache.insertCardLink(new CardLinkRow(cardId, card.boardId(), conn, i.extId(), clock.instant(), by, false, false, null));
        if (added) {
            String pill = "@[workitem:" + conn + "/" + i.extId() + "|" + i.type() + " " + i.extId() + " " + flat(i.title()) + "]";
            if (card.description() == null || !card.description().contains("@[workitem:" + conn + "/" + i.extId() + "|")) {
                port().appendToDescription(cardId, "Linked in Azure: " + pill);
            }
        }
        BoardItemsUseCase bi = boardItems.getIfAvailable();
        if (bi != null) {
            bi.cardItem(card.boardId(), conn, i.extId());
        }
        signals.board(card.boardId(), conn, "cards", Map.of("card", cardId));
        return items(cardId);
    }

    static String flat(String title) {
        String t = title == null ? "" : title.replaceAll("[\\r\\n\\t\\]|]+", " ").strip();
        return t.length() > 80 ? t.substring(0, 79) + "…" : t;
    }

    @Override
    public WriteBundle create(Who who, String cardId, String conn, NewItem item, Markers markers) {
        CardInfo card = card(cardId);
        live.stored(conn);
        if (item == null || item.type() == null || item.type().isBlank() || item.title() == null || item.title().isBlank()) {
            throw TeamException.invalid("A new item names its type and title");
        }
        Map<String, String> p = new LinkedHashMap<>();
        p.put("type", item.type().strip());
        p.put("title", item.title().strip());
        put(p, "project", item.project());
        put(p, "description", item.description() == null || item.description().isBlank() ? card.description() : item.description());
        put(p, "area", item.area());
        put(p, "iteration", item.iteration());
        put(p, "assignee", item.assignee());
        List<WriteStep> steps = new ArrayList<>();
        steps.add(new WriteStep(StepKind.CREATE, p, true, false, null));
        steps.addAll(markerSteps(card, markers == null ? Markers.ALL : markers));
        return writes().create(who, new NewBundle(card.boardId(), cardId, conn, null, "Create a " + item.type().strip() + " in Azure from card #"
                + card.number(), steps, null, null));
    }

    private static void put(Map<String, String> m, String k, String v) {
        if (v != null && !v.isBlank()) {
            m.put(k, v);
        }
    }

    @Override
    public LinkResult unlink(Who who, String cardId, String conn, String item) {
        if (who != Who.USER) {
            throw TeamException.userOnly("Only the user unlinks a card from an item");
        }
        CardLinkRow l = cache.cardLinks(cardId).stream().filter(x -> x.conn().equals(conn) && x.item().equals(item)).findFirst()
                .orElseThrow(() -> TeamException.notFound("Card " + cardId + " does not link item " + item));
        cache.deleteCardLink(cardId, conn, item);
        BoardItemsUseCase bi = boardItems.getIfAvailable();
        if (bi != null) {
            bi.cardItemGone(l.boardId(), conn, item);
        }
        cache.dropCopyIfUnused(conn, item);
        WriteBundle bundle = null;
        AzureWritesUseCase w = writes.getIfAvailable();
        if (w != null && (l.hyperlink() || l.tag())) {
            // FR-075: what the link wrote in Azure is offered for removal, never removed silently
            List<WriteStep> steps = AzureWritesService.cleanup(cache, l, cardId);
            if (!steps.isEmpty()) {
                bundle = w.create(Who.USER, new NewBundle(l.boardId(), cardId, conn, item, "Clean up in Azure: item " + item + " unlinked", steps,
                        null, null));
            }
        }
        signals.board(l.boardId(), conn, "cards", Map.of("card", cardId));
        return new LinkResult(items(cardId), bundle);
    }
}
