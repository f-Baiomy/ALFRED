package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.application.port.in.AzureWritesUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.BoardItemsUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.CardItemsUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException.Code;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamBoardsPort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamBoardsPort.CardInfo;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort.HookRow;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCallerPort;
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamChangeSignalPort;
import com.fathy.alfred.backend.teamboards.spi.model.ItemUpdate;
import com.fathy.alfred.backend.teamboards.core.application.service.Live.Ctx;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardItemRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BundleCheck;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.CardLinkRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.StepCheck;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.StateRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.StepKind;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.StepResult;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WriteBundle;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WriteState;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WriteStep;
import com.fathy.alfred.backend.teamboards.spi.AttachmentWriter;
import com.fathy.alfred.backend.teamboards.spi.ItemWriter;
import com.fathy.alfred.backend.teamboards.spi.StateCatalog;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.NewItem;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.event.ContextRefreshedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.time.Clock;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Consent bundles (specs/028 R9). The only class that calls {@link ItemWriter} / {@link AttachmentWriter} (ArchUnit):
 * for a bundle the user approved, or for the user's own direct action. Claude can create and extend, never approve.
 */
@Service
public class AzureWritesService implements AzureWritesUseCase {

    /** A field step names a field by its reference name; these are set another way or kept by the tracker. */
    static final java.util.regex.Pattern FIELD_NAME = java.util.regex.Pattern.compile("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+");
    static final java.util.Set<String> NOT_A_FIELD_WRITE = java.util.Set.of("system.state", "system.id", "system.rev", "system.changeddate",
            "system.createddate", "system.changedby", "system.createdby", "system.authorizeddate", "system.reviseddate", "system.watermark",
            "system.workitemtype", "system.teamproject", "system.history");

    /** The relations a step may add or remove (specs/038 FR-1, FR-4). */
    static final java.util.Set<String> LINK_KINDS = java.util.Set.of("parent", "child", "related", "predecessor", "successor", "duplicate",
            "duplicate of", "tested by", "tests");
    /** specs/038 G-7: Claude's bundles waiting on one board, at most. */
    static final int MAX_CLAUDE_WAITING = 5;
    /** The Team setting that lets Claude prepare changes (specs/038 G-8); off refuses every draft of Claude's. */
    public static final String CLAUDE_DRAFTS = "claude-drafts";

    private static final Logger log = LoggerFactory.getLogger(AzureWritesService.class);
    static final String CREATED = "$created";

    private final Live live;
    private final TeamCachePort cache;
    private final TeamChangeSignalPort signals;
    private final ObjectProvider<TeamBoardsPort> boards;
    private final ObjectProvider<CardItemsUseCase> cardItems;
    private final ObjectProvider<BoardItemsUseCase> boardItems;
    private final Clock clock;
    Executor runner = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "team-writes");
        t.setDaemon(true);
        return t;
    });

    @Autowired
    public AzureWritesService(Live live, TeamCachePort cache, TeamChangeSignalPort signals, ObjectProvider<TeamBoardsPort> boards,
                              ObjectProvider<CardItemsUseCase> cardItems, ObjectProvider<BoardItemsUseCase> boardItems) {
        this(live, cache, signals, boards, cardItems, boardItems, Clock.systemUTC());
    }

    AzureWritesService(Live live, TeamCachePort cache, TeamChangeSignalPort signals, ObjectProvider<TeamBoardsPort> boards,
                       ObjectProvider<CardItemsUseCase> cardItems, ObjectProvider<BoardItemsUseCase> boardItems, Clock clock) {
        this.live = live;
        this.cache = cache;
        this.signals = signals;
        this.boards = boards;
        this.cardItems = cardItems;
        this.boardItems = boardItems;
        this.clock = clock;
    }

    // ------------------------------------------------------------------------------------------------------- checks

    static void check(List<WriteStep> steps) {
        if (steps == null || steps.isEmpty()) {
            throw TeamException.invalid("A bundle has at least one step");
        }
        if (steps.size() > MAX_STEPS) {
            throw TeamException.invalid("A bundle has at most " + MAX_STEPS + " steps");
        }
        for (WriteStep s : steps) {
            if (s == null || s.kind() == null) {
                throw TeamException.invalid("Every step names its kind");
            }
            Map<String, String> p = s.payload();
            for (Map.Entry<String, String> e : p.entrySet()) {
                if (e.getValue() != null && e.getValue().length() > 256 * 1024) {
                    throw TeamException.invalid("A step's " + e.getKey() + " is at most 256 KB");
                }
            }
            String missing = switch (s.kind()) {
                case STATE -> p.get("category") != null && p.get("state") == null ? null : need(p, "state"); // a category is named when drafted
                case COMMENT -> need(p, "text");
                case ATTACH -> need(p, "name");
                case HYPERLINK, UNHYPERLINK -> need(p, "url");
                case TAG, UNTAG -> need(p, "tag");
                // a copy or a template fills type and title when the step is drafted (annotate); after that they are needed
                case CREATE -> p.get("copyOf") != null || p.get("template") != null ? null : need(p, "type") != null ? "type" : need(p, "title");
                case LINK_ALFRED -> p.get("card") == null && p.get("board") == null ? "card or board" : null;
                case FIELD -> StepPayloads.isEdit(p) ? null : need(p, "field");
            };
            if (missing != null) {
                throw TeamException.invalid(s.kind() + " needs " + missing);
            }
            if (s.kind() == StepKind.FIELD || s.kind() == StepKind.CREATE) {
                List<String> names = new ArrayList<>(StepPayloads.fields(p).keySet());
                if (s.kind() == StepKind.FIELD && p.get("field") != null && !p.get("field").isBlank()) {
                    names.add(p.get("field").strip());
                }
                for (String f : names) {
                    if (!FIELD_NAME.matcher(f).matches() || NOT_A_FIELD_WRITE.contains(f.toLowerCase(java.util.Locale.ROOT))) {
                        throw TeamException.invalid("Set " + f + " another way: a field step takes a field's reference name (e.g. "
                                + "Microsoft.VSTS.Common.Priority), not the state, id, revision or a date the tracker keeps");
                    }
                }
                for (String key : List.of("links", "addLinks", "removeLinks")) {
                    for (var l : StepPayloads.links(p, key)) {
                        if (!LINK_KINDS.contains(l.kind().strip().toLowerCase(Locale.ROOT).replace("-", " ").replace("_", " "))) {
                            throw TeamException.invalid("Unknown link kind " + l.kind() + " - use Parent, Child, Related, Predecessor, Successor, "
                                    + "Duplicate, Duplicate of, Tested by or Tests");
                        }
                    }
                }
                if (s.kind() == StepKind.FIELD && StepPayloads.isEdit(p) && StepPayloads.update(p).empty()) {
                    throw TeamException.invalid("FIELD changes nothing - give fields, a state, a parent, links or tags");
                }
            }
            if ((s.kind() == StepKind.HYPERLINK || s.kind() == StepKind.UNHYPERLINK) && !https(p.get("url"))) {
                throw TeamException.invalid("A hyperlink is an http(s) address");
            }
        }
    }

    private static String need(Map<String, String> p, String key) {
        String v = p.get(key);
        return v == null || v.isBlank() ? key : null;
    }

    private static boolean https(String url) {
        try {
            URI u = URI.create(url.strip());
            return u.getHost() != null && ("https".equalsIgnoreCase(u.getScheme()) || "http".equalsIgnoreCase(u.getScheme()));
        } catch (IllegalArgumentException | NullPointerException e) {
            return false;
        }
    }

    // ------------------------------------------------------------------------------------------------------- create

    @Override
    public WriteBundle create(Who who, NewBundle in) {
        if (in == null) {
            throw TeamException.invalid("No bundle");
        }
        live.stored(in.conn());
        if (who == Who.CLAUDE && !claudeMayDraft()) {
            throw TeamException.userOnly("The user turned off Claude's Azure changes (Settings ▸ Team) - tell them what you would change instead");
        }
        check(in.steps());
        if (in.title() == null || in.title().isBlank() || in.title().length() > 300) {
            throw TeamException.invalid("A bundle's title is 1 to 300 characters");
        }
        // every step knows its item: the bundle's, its own (`item`, specs/038 FR-3), or the one a CREATE makes
        boolean creates = in.steps().stream().anyMatch(s -> s.kind() == StepKind.CREATE);
        boolean ownItems = in.steps().stream().allMatch(s -> s.kind() == StepKind.CREATE || StepPayloads.blank(s.payload().get("item")) != null);
        if (!creates && !ownItems && (in.item() == null || in.item().isBlank())) {
            throw TeamException.invalid("A bundle names its item (or creates one)");
        }
        if (in.extend() != null) {
            WriteBundle old = get(in.extend()).orElseThrow(() -> TeamException.notFound("No bundle " + in.extend()));
            if (old.state() != WriteState.WAITING) {
                throw new TeamException(Code.CONFLICT, "Bundle " + old.id() + " is " + old.state() + " - start another");
            }
            if (who == Who.CLAUDE && (!Who.CLAUDE.name().equals(old.origin()) || !old.conn().equals(in.conn())
                    || !java.util.Objects.equals(old.item(), blank(in.item())) || !java.util.Objects.equals(old.cardId(), blank(in.cardId())))) {
                throw TeamException.userOnly("Claude extends only its own waiting bundle for the same item and card - start another");
            }
            List<WriteStep> steps = new ArrayList<>(old.steps());
            List<WriteStep> added = annotate(old.conn(), old.item(), in.steps().stream().map(s -> fresh(s, who)).toList(), who);
            check(added);
            steps.addAll(dryRun(old.conn(), old.item(), added, old.steps().size(), who == Who.CLAUDE));
            check(steps);
            WriteBundle next = new WriteBundle(old.id(), old.boardId(), old.cardId(), old.conn(), old.item(), old.origin(), old.askedIn(), old.title(),
                    steps, WriteState.WAITING, old.createdAt(), null, null);
            cache.updateBundle(next);
            signal(next);
            return next;
        }
        // a bundle made for a card belongs to the card's board: the board then counts it (specs/034 - it used to have none)
        String boardId = blank(in.boardId()) != null ? boardOf(in.conn(), blank(in.boardId())) : boardOfCard(blank(in.cardId()));
        List<WriteStep> steps = annotate(in.conn(), blank(in.item()), underMain(in.conn(), boardId, in.steps()).stream().map(s -> fresh(s, who)).toList(),
                who);
        check(steps);
        if (who == Who.CLAUDE && boardId != null && cache.bundles(boardId, null, WriteState.WAITING.name(), 100).stream()
                .filter(x -> Who.CLAUDE.name().equals(x.origin())).count() >= MAX_CLAUDE_WAITING) {
            throw new TeamException(Code.CONFLICT, MAX_CLAUDE_WAITING + " of your bundles already wait for the user on this board - extend one "
                    + "of them (extend) or wait for the user to decide");
        }
        // Azure checks it now (specs/038 G-1): a refusal is Claude's to fix, never the user's to find after approving
        steps = dryRun(in.conn(), blank(in.item()), steps, 0, who == Who.CLAUDE);
        WriteBundle b = new WriteBundle(0, boardId, blank(in.cardId()), in.conn(), blank(in.item()), who.name(), blank(in.askedIn()),
                in.title().strip(), steps, WriteState.WAITING, clock.instant(), null, null);
        long id = cache.insertBundle(b);
        WriteBundle saved = get(id).orElse(b);
        signal(saved);
        return saved;
    }

    /**
     * The board id a ref names: the id itself, or the board whose main item an "AB#123" / "123" names. Claude once stored
     * "AB#61813" as the board, and the board's header never counted the bundle (2026-10-19). An unknown ref stays as given.
     */
    String boardOf(String conn, String ref) {
        TeamBoardsPort port = boards.getIfAvailable();
        if (ref == null || port == null || port.boardName(ref).isPresent()) {
            return ref;
        }
        Matcher m = BOARD_ITEM.matcher(ref.strip());
        if (!m.matches()) {
            return ref;
        }
        List<String> mains = cache.boardsOfItem(conn, m.group(1)).stream().filter(r -> "MAIN".equals(r.role()))
                .map(BoardItemRow::boardId).distinct().toList();
        return mains.size() == 1 ? mains.get(0) : ref;
    }

    private static final Pattern BOARD_ITEM = Pattern.compile("(?i)(?:AB)?#?(\\d+)");

    /** The board a card is on, or null. */
    private String boardOfCard(String cardId) {
        if (cardId == null) {
            return null;
        }
        TeamBoardsPort port = boards.getIfAvailable();
        return port == null ? null : port.card(cardId).map(CardInfo::boardId).orElse(null);
    }

    /**
     * Every state or field step remembers the item's value when it was made ({@code from}: read live when a token is
     * there, else the saved copy) and every Claude comment its first draft ({@code draft}), so the review shows old -> new
     * and what the user changed (specs/034). Best effort: an item that cannot be read leaves {@code from} out.
     */
    List<WriteStep> annotate(String conn, String item, List<WriteStep> steps, Who who) {
        Map<String, Optional<Item>> read = new java.util.HashMap<>();
        java.util.function.Function<String, Item> itemOf = id -> id == null ? null : read.computeIfAbsent(id, x -> Optional.ofNullable(readItem(conn, x)))
                .orElse(null);
        List<WriteStep> out = new ArrayList<>();
        for (WriteStep s : steps) {
            Map<String, String> p = new LinkedHashMap<>(s.payload());
            String target = target(s, item);
            if (s.kind() == StepKind.CREATE) {
                expandCreate(conn, p, itemOf);
            } else if (s.kind() == StepKind.STATE && target != null) {
                Item now = itemOf.apply(target);
                if (StepPayloads.blank(p.get("state")) == null && p.get("category") != null) {
                    // specs/038 FR-9: "Removed" / "Completed" in the type's own words
                    String state = now == null ? null : stateIn(conn, now.type(), p.get("category").strip());
                    if (state == null) {
                        throw TeamException.invalid("No " + p.get("category").strip() + " state for this item's type - name the state");
                    }
                    p.put("state", state);
                }
                if (now != null && !p.containsKey("from")) {
                    p.put("from", now.state() == null ? "" : now.state());
                }
            } else if (s.kind() == StepKind.FIELD && target != null && !p.containsKey("from") && !p.containsKey("fromFields")) {
                Item now = itemOf.apply(target);
                if (now != null && StepPayloads.isEdit(p)) {
                    // before -> after for every field it changes (specs/038 FR-4), its parent and tags too
                    Map<String, String> from = new LinkedHashMap<>();
                    for (String f : StepPayloads.update(p).fields().keySet()) {
                        String v = now.fields().get(f);
                        from.put(f, v == null ? "" : v);
                    }
                    p.put("fromFields", StepPayloads.write(from));
                    if (p.containsKey("parent")) {
                        p.put("fromParent", now.links().stream().filter(l -> "Parent".equals(l.kind())).map(com.fathy.alfred.backend.teamboards.spi.model.Link::toId)
                                .findFirst().orElse(""));
                    }
                    if (p.containsKey("state")) {
                        p.put("fromState", now.state() == null ? "" : now.state());
                    }
                    if (p.containsKey("addTags") || p.containsKey("removeTags")) {
                        p.put("fromTags", now.fields().getOrDefault("System.Tags", ""));
                    }
                } else if (now != null && p.get("field") != null) {
                    String v = now.fields().get(p.get("field").strip());
                    p.put("from", v == null ? "" : v);
                }
            } else if (who == Who.CLAUDE && s.kind() == StepKind.COMMENT && !p.containsKey("draft")) {
                p.put("draft", p.get("text"));
            }
            out.add(new WriteStep(s.kind(), p, s.ticked(), s.unmasked(), s.result()));
        }
        return out;
    }

    /**
     * Azure's own check of each CREATE, FIELD and STATE step (specs/038 G-1, G-2), changing nothing: the answer is kept on
     * the step ({@code azureCheck}: "ok", "refused: …" or why it was not checked). {@code refuse}: a refusal throws with
     * Azure's words and nothing is saved - Claude's drafts and every approve. A step for an item a CREATE before it makes
     * is checked when that item exists.
     */
    List<WriteStep> dryRun(String conn, String item, List<WriteStep> steps, int offset, boolean refuse) {
        Optional<Ctx> ctx;
        try {
            ctx = live.ctxIfLive(conn);
        } catch (RuntimeException e) {
            ctx = Optional.empty();
        }
        List<WriteStep> out = new ArrayList<>();
        List<String> refused = new ArrayList<>();
        String now = clock.instant().toString();
        for (int i = 0; i < steps.size(); i++) {
            WriteStep s = steps.get(i);
            boolean checked = s.ticked() && (s.kind() == StepKind.CREATE || s.kind() == StepKind.FIELD || s.kind() == StepKind.STATE);
            if (!checked) {
                out.add(s);
                continue;
            }
            Map<String, String> p = new LinkedHashMap<>(s.payload());
            String target = s.kind() == StepKind.CREATE ? null : target(s, item);
            if (s.kind() != StepKind.CREATE && target == null) {
                p.put("azureCheck", "checked when the new item exists");
            } else if (ctx.isEmpty()) {
                p.put("azureCheck", "not checked - no Azure token in Alfred yet");
            } else {
                Ctx c = ctx.get();
                try {
                    ItemWriter w = live.cap(c, ItemWriter.class, "check a change");
                    boolean asked = live.call(c, () -> s.kind() == StepKind.CREATE ? w.validateCreate(c.connection(), c.token(), StepPayloads.newItem(p))
                            : w.validateUpdate(c.connection(), c.token(), target, s.kind() == StepKind.STATE
                            ? new ItemUpdate(Map.of(), p.get("state").strip(), null, null, null, null, null) : StepPayloads.update(p)));
                    p.put("azureCheck", asked ? "ok" : "not checked - this tracker cannot check in advance");
                } catch (TeamException e) {
                    if (e.code() == Code.TOKEN_MISSING || e.code() == Code.TOKEN_REJECTED || e.code() == Code.UNREACHABLE
                            || e.code() == Code.PROVIDER_BUSY || e.code() == Code.NOT_SUPPORTED) {
                        p.put("azureCheck", "not checked - " + e.getMessage());
                    } else {
                        p.put("azureCheck", "refused: " + e.getMessage());
                        refused.add("step " + (offset + i + 1) + ": " + e.getMessage());
                        ItemFieldsService.forget(conn);
                    }
                } catch (IllegalArgumentException e) {
                    p.put("azureCheck", "refused: " + e.getMessage());
                    refused.add("step " + (offset + i + 1) + ": " + e.getMessage());
                }
            }
            p.put("checkedAt", now);
            out.add(new WriteStep(s.kind(), p, s.ticked(), s.unmasked(), s.result()));
        }
        if (refuse && !refused.isEmpty()) {
            throw TeamException.invalid("Azure DevOps refuses this - nothing was saved or sent. " + String.join("; ", refused)
                    + ". team_item_type_fields lists what the type requires and allows.");
        }
        return out;
    }

    /** specs/038 G-8: whether the user lets Claude prepare changes for the tracker (on unless turned off). */
    public boolean claudeMayDraft() {
        return !"off".equals(cache.setting(CLAUDE_DRAFTS).orElse("on"));
    }

    /** Who decides (specs/038 G-4): only the user's browser - never Claude, a helper's key or a session. */
    private String decider(Who who, String what) {
        if (who != Who.USER) {
            throw TeamException.userOnly("Only the user " + what + " - from the board in their browser");
        }
        TeamCallerPort callers = this.callers == null ? null : this.callers.getIfAvailable();
        if (callers == null) {
            return "user";
        }
        callers.refuseDecision().ifPresent(why -> {
            throw TeamException.userOnly(why);
        });
        return callers.user().orElse("user");
    }

    private ObjectProvider<TeamCallerPort> callers;

    @Autowired(required = false)
    void setCallers(ObjectProvider<TeamCallerPort> callers) {
        this.callers = callers;
    }

    /**
     * specs/030: a new item goes under the board's main item unless its step names a parent - {@code "parent": ""} keeps
     * it without one (specs/038 FR-1).
     */
    private List<WriteStep> underMain(String conn, String boardId, List<WriteStep> steps) {
        if (boardId == null || steps.stream().noneMatch(s -> s.kind() == StepKind.CREATE && !s.payload().containsKey("parent") && !s.payload().containsKey("copyOf"))) {
            return steps;
        }
        String main = cache.main(boardId).filter(m -> m.conn().equals(conn)).map(BoardItemRow::item).orElse(null);
        if (main == null) {
            return steps;
        }
        List<WriteStep> out = new ArrayList<>();
        for (WriteStep s : steps) {
            if (s.kind() == StepKind.CREATE && !s.payload().containsKey("parent") && !s.payload().containsKey("copyOf")) {
                Map<String, String> p = new LinkedHashMap<>(s.payload());
                p.put("parent", main);
                out.add(new WriteStep(s.kind(), p, s.ticked(), s.unmasked(), s.result()));
            } else {
                out.add(s);
            }
        }
        return out;
    }

    /** The item a step is for: its own {@code item} (specs/038 FR-3), else the bundle's. */
    static String target(WriteStep s, String bundleItem) {
        String own = StepPayloads.blank(s.payload().get("item"));
        return own != null ? own : bundleItem;
    }

    /** The item now (live when a token is there, else the saved copy), or null when neither can be had. */
    private Item readItem(String conn, String id) {
        try {
            Item now = live.ctxIfLive(conn).map(c -> live.item(c, id)).orElse(null);
            if (now != null) {
                return now;
            }
        } catch (RuntimeException e) {
            // not readable now: the saved copy, if any
        }
        return cache.copy(conn, id).flatMap(Copies::item).orElse(null);
    }

    /** The first state of a type in a category (Removed, Completed), or null. */
    private String stateIn(String conn, String type, String category) {
        String fallback = null;
        for (StateRow s : cache.states(conn)) {
            if (category.equalsIgnoreCase(s.category())) {
                if (type != null && type.equalsIgnoreCase(s.type())) {
                    return s.name();
                }
                fallback = fallback == null ? s.name() : fallback;
            }
        }
        return fallback;
    }

    /** Fields Azure keeps itself or that belong to one item's life only: never copied (specs/038 FR-5). */
    static final java.util.Set<String> NOT_COPIED = java.util.Set.of("system.id", "system.rev", "system.state", "system.reason",
            "system.createddate", "system.createdby", "system.changeddate", "system.changedby", "system.authorizeddate", "system.reviseddate",
            "system.watermark", "system.commentcount", "system.teamproject", "system.workitemtype", "system.boardcolumn", "system.boardcolumndone",
            "system.boardlane", "system.history", "system.authorizedas", "system.nodename", "system.areaid", "system.iterationid", "system.personid",
            "system.relatedlinkcount", "system.externallinkcount", "system.hyperlinkcount", "system.attachedfilecount", "system.remotelinkcount",
            "microsoft.vsts.common.statechangedate", "microsoft.vsts.common.activateddate", "microsoft.vsts.common.activatedby",
            "microsoft.vsts.common.closeddate", "microsoft.vsts.common.closedby", "microsoft.vsts.common.resolveddate",
            "microsoft.vsts.common.resolvedby", "microsoft.vsts.common.resolvedreason", "microsoft.vsts.scheduling.completedwork");

    static boolean copied(String field) {
        String f = field.toLowerCase(Locale.ROOT);
        return !NOT_COPIED.contains(f) && !f.startsWith("system.arealevel") && !f.startsWith("system.iterationlevel")
                && !f.startsWith("wef_") && !f.contains("kanban");
    }

    /**
     * A CREATE as it will be sent, filled in when drafted so the user sees every value (specs/038): a template's fields
     * (FR-11), a copied item's writable fields (FR-5), area and iteration from the parent ({@code inherit}, FR-6). What
     * the step gives itself always wins.
     */
    private void expandCreate(String conn, Map<String, String> p, java.util.function.Function<String, Item> itemOf) {
        Map<String, String> fields = new LinkedHashMap<>();
        String template = StepPayloads.blank(p.get("template"));
        if (template != null) {
            var t = cache.template(conn, template).orElseThrow(() -> TeamException.notFound("No template " + template
                    + " - team_templates lists them"));
            fields.putAll(StepPayloads.object(t.fieldsJson(), "the template"));
            p.putIfAbsent("type", t.type());
        }
        String copyOf = StepPayloads.blank(p.get("copyOf"));
        if (copyOf != null) {
            Item src = itemOf.apply(copyOf);
            if (src == null) {
                throw TeamException.invalid("Item " + copyOf + " cannot be read now - enter the Azure token first, then copy it");
            }
            for (Map.Entry<String, String> f : src.fields().entrySet()) {
                if (copied(f.getKey()) && f.getValue() != null && !f.getValue().isBlank()) {
                    fields.put(f.getKey(), f.getValue());
                }
            }
            p.putIfAbsent("type", src.type());
            p.putIfAbsent("title", src.title());
            p.putIfAbsent("project", src.project());
            if (!p.containsKey("parent")) {
                src.links().stream().filter(l -> "Parent".equals(l.kind())).findFirst().ifPresent(l -> p.put("parent", l.toId()));
            }
            // the shortcuts below are sent as their own fields; a copy keeps them in `fields`
            fields.remove("System.Title");
        }
        String parent = StepPayloads.blank(p.get("parent"));
        if ("1".equals(p.get("inherit")) && parent != null) {
            Item up = itemOf.apply(parent);
            if (up != null) {
                p.putIfAbsent("area", up.area());
                p.putIfAbsent("iteration", up.sprint());
                p.putIfAbsent("project", up.project());
            }
        }
        if (fields.isEmpty() && template == null && copyOf == null) {
            return;
        }
        // the step's own fields and shortcuts win over a template's or a copy's
        fields.putAll(StepPayloads.fields(p));
        for (String shortcut : List.of("description:System.Description", "area:System.AreaPath", "iteration:System.IterationPath",
                "assignee:System.AssignedTo")) {
            String key = shortcut.substring(0, shortcut.indexOf(':'));
            String field = shortcut.substring(shortcut.indexOf(':') + 1);
            if (StepPayloads.blank(p.get(key)) != null) {
                fields.remove(field);
            } else if (fields.containsKey(field)) {
                p.put(key, fields.remove(field));
            }
        }
        p.put("fields", StepPayloads.write(fields));
    }

    /**
     * Bundles made before specs/034 had no board when they came from a card, and some were stored with a board ref
     * ("AB#61813") instead of its id: they get their board at start (the latest 200).
     */
    @EventListener(ContextRefreshedEvent.class)
    public void fillBoards() {
        try {
            for (WriteBundle b : cache.bundles(null, null, null, 200)) { // waiting ones for the header, ended ones for the chat's trail
                String fixed = b.boardId() == null ? null : boardOf(b.conn(), b.boardId());
                String board = b.boardId() == null ? boardOfCard(b.cardId()) : fixed.equals(b.boardId()) ? null : fixed;
                if (board != null) {
                    cache.updateBundle(new WriteBundle(b.id(), board, b.cardId(), b.conn(), b.item(), b.origin(), b.askedIn(), b.title(), b.steps(),
                            b.state(), b.createdAt(), b.decidedAt(), b.decidedBy()));
                }
            }
        } catch (RuntimeException e) {
            log.warn("Could not give older bundles their board: {}", e.getClass().getSimpleName());
        }
    }

    /** A new step: no result yet; Claude never sends a file unmasked - only the user ticks that. */
    private static WriteStep fresh(WriteStep s, Who who) {
        return new WriteStep(s.kind(), s.payload(), s.ticked(), who == Who.USER && s.unmasked(), null);
    }

    private static String blank(String s) {
        return s == null || s.isBlank() ? null : s.strip();
    }

    @Override
    public WriteBundle direct(String conn, String item, String boardId, String cardId, String title, List<WriteStep> steps) {
        // the user's own action from the Team tab or a card runs at once - so only from the user's browser (specs/038 G-4)
        String by = decider(Who.USER, "changes the tracker directly");
        check(steps);
        Ctx c = live.ctx(conn);
        List<WriteStep> ticked = steps.stream().map(s -> new WriteStep(s.kind(), s.payload(), true, s.unmasked(), null)).toList();
        WriteBundle b = new WriteBundle(0, blank(boardId), blank(cardId), conn, blank(item), Who.USER.name(), null,
                title == null || title.isBlank() ? "Your change in " + c.stored().name() : title.strip(), ticked, WriteState.SENDING, clock.instant(),
                clock.instant(), by);
        long id = cache.insertBundle(b);
        WriteBundle saved = get(id).orElse(b);
        WriteBundle done = run(c, saved);
        if (done.state() == WriteState.PARTIAL) {
            String why = done.steps().stream().filter(s -> s.result() != null && !s.result().ok()).map(s -> s.result().message()).findFirst()
                    .orElse("the tracker refused it");
            throw new TeamException(Code.BAD_RESPONSE, why);
        }
        return done;
    }

    @Override
    public Optional<WriteBundle> get(long id) {
        return cache.bundle(id);
    }

    @Override
    public List<WriteBundle> list(String boardId, String cardId, String state, int limit) {
        String s = state == null || state.isBlank() ? null : state.strip().toUpperCase(Locale.ROOT);
        if (s != null) {
            try {
                WriteState.valueOf(s);
            } catch (IllegalArgumentException e) {
                throw TeamException.invalid("state is WAITING, SENDING, DONE, PARTIAL or REJECTED");
            }
        }
        return cache.bundles(blank(boardId), blank(cardId), s, limit <= 0 ? 50 : limit);
    }

    private WriteBundle waiting(long id) {
        WriteBundle b = get(id).orElseThrow(() -> TeamException.notFound("No bundle " + id));
        if (b.state() != WriteState.WAITING) {
            throw new TeamException(Code.CONFLICT, "Bundle " + id + " is " + b.state());
        }
        return b;
    }

    @Override
    public WriteBundle edit(Who who, long id, String title, List<WriteStep> steps) {
        decider(who, "edits a bundle - Claude extends it (extend) or redrafts its own");
        WriteBundle b = waiting(id);
        List<WriteStep> next = new ArrayList<>(steps == null ? b.steps()
                : steps.stream().map(s -> new WriteStep(s.kind(), s.payload(), s.ticked(), s.unmasked(), null)).toList());
        check(next);
        // a changed step is a new draft: Azure's earlier answer no longer holds for it (specs/038 G-5)
        for (int i = 0; i < next.size(); i++) {
            WriteStep s = next.get(i);
            WriteStep was = i < b.steps().size() ? b.steps().get(i) : null;
            if (was == null || !withoutCheck(was.payload()).equals(withoutCheck(s.payload()))) {
                Map<String, String> p = withoutCheck(s.payload());
                next.set(i, new WriteStep(s.kind(), p, s.ticked(), s.unmasked(), null));
                next.set(i, dryRun(b.conn(), b.item(), List.of(next.get(i)), i, false).get(0));
            }
        }
        // a built file belongs to its step as it was built: a changed step (or its "send unmasked") needs it built again
        for (int i = 0; i < next.size(); i++) {
            WriteStep s = next.get(i);
            if (s.kind() != StepKind.ATTACH) {
                continue;
            }
            WriteStep was = i < b.steps().size() ? b.steps().get(i) : null;
            boolean built = was != null && was.kind() == StepKind.ATTACH && "1".equals(was.payload().get("built"));
            boolean same = built && String.valueOf(s.unmasked()).equals(was.payload().get("builtUnmasked"))
                    && stripBuilt(s.payload()).equals(stripBuilt(was.payload()));
            if (same) {
                next.set(i, new WriteStep(s.kind(), was.payload(), s.ticked(), s.unmasked(), null));
            } else {
                cache.deleteBundleFile(id, i);
                next.set(i, new WriteStep(s.kind(), stripBuilt(s.payload()), s.ticked(), s.unmasked(), null));
            }
        }
        WriteBundle out = new WriteBundle(b.id(), b.boardId(), b.cardId(), b.conn(), b.item(), b.origin(), b.askedIn(),
                title == null || title.isBlank() ? b.title() : title.strip(), next, WriteState.WAITING, b.createdAt(), null, null);
        cache.updateBundle(out);
        signal(out);
        return out;
    }

    private static Map<String, String> withoutCheck(Map<String, String> p) {
        Map<String, String> out = new LinkedHashMap<>(p);
        out.remove("azureCheck");
        out.remove("checkedAt");
        return out;
    }

    private static Map<String, String> stripBuilt(Map<String, String> p) {
        Map<String, String> out = new LinkedHashMap<>(p);
        out.remove("built");
        out.remove("builtUnmasked");
        out.remove("size");
        return out;
    }

    @Override
    public WriteBundle putFile(Who who, long id, int step, String name, byte[] data) {
        if (who != Who.USER) {
            throw TeamException.userOnly("Only the user's browser builds an evidence file - it masks it there");
        }
        WriteBundle b = waiting(id);
        if (step < 0 || step >= b.steps().size() || b.steps().get(step).kind() != StepKind.ATTACH) {
            throw TeamException.invalid("Step " + step + " is not an attachment step");
        }
        if (data == null || data.length == 0 || data.length > MAX_FILE) {
            throw TeamException.invalid("A file is 1 byte to 60 MB");
        }
        String n = name == null || name.isBlank() ? b.steps().get(step).payload().get("name") : name.strip();
        if (n.length() > 200 || n.contains("/") || n.contains("\\")) {
            throw TeamException.invalid("A file name is at most 200 characters, without a folder");
        }
        cache.putBundleFile(id, step, n, data);
        List<WriteStep> steps = new ArrayList<>(b.steps());
        WriteStep s = steps.get(step);
        Map<String, String> p = new LinkedHashMap<>(s.payload());
        p.put("name", n);
        p.put("size", String.valueOf(data.length));
        p.put("built", "1");
        p.put("builtUnmasked", String.valueOf(s.unmasked()));
        steps.set(step, new WriteStep(s.kind(), p, s.ticked(), s.unmasked(), null));
        WriteBundle out = new WriteBundle(b.id(), b.boardId(), b.cardId(), b.conn(), b.item(), b.origin(), b.askedIn(), b.title(), steps,
                WriteState.WAITING, b.createdAt(), null, null);
        cache.updateBundle(out);
        signal(out);
        return out;
    }

    @Override
    public WriteBundle approve(Who who, long id) {
        String by = decider(who, "approves what goes to the tracker");
        WriteBundle b = waiting(id);
        for (int i = 0; i < b.steps().size(); i++) {
            WriteStep s = b.steps().get(i);
            if (s.ticked() && s.kind() == StepKind.ATTACH && cache.bundleFile(id, i).isEmpty()) {
                throw TeamException.invalid("Step " + (i + 1) + " (" + s.payload().get("name") + ") has no file yet - build it first, or untick it");
            }
            if (s.ticked() && s.kind() == StepKind.ATTACH && !String.valueOf(s.unmasked()).equals(s.payload().get("builtUnmasked"))) {
                throw TeamException.invalid("Step " + (i + 1) + " (" + s.payload().get("name") + ") was built "
                        + (s.unmasked() ? "masked" : "unmasked") + " - build it again");
            }
        }
        if (b.steps().stream().noneMatch(WriteStep::ticked)) {
            throw TeamException.invalid("Tick at least one step, or reject the bundle");
        }
        Ctx c = live.ctx(b.conn()); // TOKEN_MISSING keeps it waiting
        // Azure checks it again now (specs/038 G-2): a refusal sends nothing and the bundle says why
        List<WriteStep> checked = dryRun(b.conn(), b.item(), b.steps(), 0, false);
        List<String> refused = new ArrayList<>();
        for (int i = 0; i < checked.size(); i++) {
            String r = checked.get(i).payload().get("azureCheck");
            if (checked.get(i).ticked() && r != null && r.startsWith("refused: ")) {
                refused.add("step " + (i + 1) + ": " + r.substring("refused: ".length()));
            }
        }
        if (!refused.isEmpty()) {
            WriteBundle shown = new WriteBundle(b.id(), b.boardId(), b.cardId(), b.conn(), b.item(), b.origin(), b.askedIn(), b.title(), checked,
                    WriteState.WAITING, b.createdAt(), null, null, b.note());
            cache.updateBundle(shown);
            signal(shown);
            throw TeamException.invalid("Azure DevOps refuses this now - nothing was sent. " + String.join("; ", refused));
        }
        WriteBundle sending = new WriteBundle(b.id(), b.boardId(), b.cardId(), b.conn(), b.item(), b.origin(), b.askedIn(), b.title(), checked,
                WriteState.SENDING, b.createdAt(), clock.instant(), by);
        cache.updateBundle(new WriteBundle(b.id(), b.boardId(), b.cardId(), b.conn(), b.item(), b.origin(), b.askedIn(), b.title(), checked,
                WriteState.WAITING, b.createdAt(), null, null, b.note()));
        if (!cache.claimSending(id, sending.decidedAt(), by)) {
            throw new TeamException(Code.CONFLICT, "Bundle " + id + " is already being sent");
        }
        signal(sending);
        runner.execute(() -> {
            try {
                run(c, sending);
            } catch (RuntimeException e) {
                log.warn("Bundle {} stopped: {}", id, e.getClass().getSimpleName());
                cache.bundle(id).ifPresent(x -> {
                    WriteBundle partial = new WriteBundle(x.id(), x.boardId(), x.cardId(), x.conn(), x.item(), x.origin(), x.askedIn(), x.title(),
                            x.steps(), WriteState.PARTIAL, x.createdAt(), x.decidedAt(), x.decidedBy());
                    cache.updateBundle(partial);
                    signal(partial);
                });
            }
        });
        return sending;
    }

    @Override
    public WriteBundle reject(Who who, long id) {
        String by = decider(who, "rejects a bundle - Claude may redraft its own instead");
        WriteBundle b = waiting(id);
        WriteBundle out = new WriteBundle(b.id(), b.boardId(), b.cardId(), b.conn(), b.item(), b.origin(), b.askedIn(), b.title(), b.steps(),
                WriteState.REJECTED, b.createdAt(), clock.instant(), by);
        cache.updateBundle(out);
        cache.deleteBundleFiles(id);
        signal(out);
        return out;
    }

    @Override
    public WriteBundle reject(Who who, long id, String reason) {
        WriteBundle out = reject(who, id);
        String why = reason == null ? "" : reason.strip();
        if (why.isEmpty()) {
            return out;
        }
        WriteBundle noted = new WriteBundle(out.id(), out.boardId(), out.cardId(), out.conn(), out.item(), out.origin(), out.askedIn(), out.title(),
                out.steps(), out.state(), out.createdAt(), out.decidedAt(), out.decidedBy(), why.length() > 1000 ? why.substring(0, 1000) : why);
        cache.updateBundle(noted);
        signal(noted);
        return noted;
    }

    // ------------------------------------------------------------------------------------------------------- check

    @Override
    public BundleCheck check(long id) {
        WriteBundle b = get(id).orElseThrow(() -> TeamException.notFound("No bundle " + id));
        boolean anyItem = b.item() != null || b.steps().stream().anyMatch(s -> StepPayloads.blank(s.payload().get("item")) != null);
        if (!anyItem) {
            return new BundleCheck(id, null, null, null, footer(b), List.of());
        }
        Ctx c = live.ctx(b.conn()); // TOKEN_MISSING: the page shows the bundle as it was made
        Map<String, Item> items = new java.util.HashMap<>();
        java.util.function.Function<String, Item> itemOf = x -> items.computeIfAbsent(x, y -> live.item(c, y));
        Item main = b.item() == null ? null : itemOf.apply(b.item());
        Map<String, Map<String, List<String>>> movesByType = new java.util.HashMap<>();
        List<StepCheck> out = new ArrayList<>();
        for (int i = 0; i < b.steps().size(); i++) {
            WriteStep s = b.steps().get(i);
            Map<String, String> p = s.payload();
            String target = target(s, b.item());
            if (target == null || (s.kind() != StepKind.STATE && s.kind() != StepKind.FIELD)) {
                continue;
            }
            Item now;
            try {
                now = itemOf.apply(target);
            } catch (TeamException e) {
                if (e.code() == Code.TOKEN_MISSING || e.code() == Code.TOKEN_REJECTED) {
                    throw e;
                }
                continue; // an item that cannot be read now (gone, no access): its step shows as it was made
            }
            if (s.kind() == StepKind.STATE) {
                Map<String, List<String>> moves = movesByType.computeIfAbsent(now.project() + "|" + now.type(), k -> {
                    try {
                        StateCatalog catalog = live.cap(c, StateCatalog.class, "list state moves");
                        return live.call(c, () -> catalog.transitions(c.connection(), c.token(), now.project(), now.type()));
                    } catch (RuntimeException e) {
                        return Map.of(); // not known: nothing is refused in advance
                    }
                });
                String value = now.state() == null ? "" : now.state();
                String want = p.getOrDefault("state", "").strip();
                List<String> allowed = moves.isEmpty() ? null : moves.entrySet().stream().filter(e -> e.getKey().equalsIgnoreCase(value))
                        .map(Map.Entry::getValue).findFirst().orElse(List.of());
                boolean refused = allowed != null && !want.equalsIgnoreCase(value) && allowed.stream().noneMatch(a -> a.equalsIgnoreCase(want));
                out.add(new StepCheck(i, value, allowed, changed(p.get("from"), value), refused));
            } else if (p.containsKey("fromFields")) {
                // several fields: the values now, and whether any moved since the draft (specs/038 FR-4)
                Map<String, String> from = StepPayloads.object(p.get("fromFields"), "fromFields");
                Map<String, String> values = new LinkedHashMap<>();
                boolean moved = false;
                for (Map.Entry<String, String> f : from.entrySet()) {
                    String v = now.fields().getOrDefault(f.getKey(), "");
                    values.put(f.getKey(), v == null ? "" : v);
                    moved |= changed(f.getValue(), v);
                }
                if (p.containsKey("fromState")) {
                    moved |= changed(p.get("fromState"), now.state());
                }
                out.add(new StepCheck(i, StepPayloads.write(values), null, moved, false));
            } else {
                String v = now.fields().get(p.getOrDefault("field", "").strip());
                String value = v == null ? "" : v;
                out.add(new StepCheck(i, value, null, changed(p.get("from"), value), false));
            }
        }
        return main == null ? new BundleCheck(id, null, null, null, footer(b), out)
                : new BundleCheck(id, main.state(), main.changedBy(), main.changedAt(), footer(b), out);
    }

    /** Whether the value moved since the step was made; a step made without one never says so. */
    static boolean changed(String from, String now) {
        return from != null && !from.strip().equalsIgnoreCase(now == null ? "" : now.strip());
    }

    // ----------------------------------------------------------------------------------------------------- redraft

    @Override
    public WriteBundle redraft(Who who, long id, int step, String text) {
        if (who != Who.CLAUDE) {
            throw TeamException.userOnly("The user changes a bundle's text by editing it; redraft is Claude's");
        }
        WriteBundle b = waiting(id);
        if (Who.USER.name().equals(b.origin())) {
            throw TeamException.userOnly("Claude redrafts only a bundle Claude or Alfred prepared");
        }
        if (step < 0 || step >= b.steps().size() || b.steps().get(step).kind() != StepKind.COMMENT) {
            throw TeamException.invalid("Step " + (step + 1) + " is not a comment step");
        }
        if (text == null || text.isBlank() || text.length() > 256 * 1024) {
            throw TeamException.invalid("A redraft is 1 character to 256 KB");
        }
        List<WriteStep> steps = new ArrayList<>(b.steps());
        WriteStep s = steps.get(step);
        Map<String, String> p = new LinkedHashMap<>(s.payload());
        p.putIfAbsent("draft", p.getOrDefault("text", ""));
        p.put("previous", p.getOrDefault("text", ""));
        p.put("text", text.strip());
        p.put("redraftedAt", clock.instant().toString());
        steps.set(step, new WriteStep(s.kind(), p, s.ticked(), s.unmasked(), null));
        WriteBundle out = new WriteBundle(b.id(), b.boardId(), b.cardId(), b.conn(), b.item(), b.origin(), b.askedIn(), b.title(), steps,
                WriteState.WAITING, b.createdAt(), null, null);
        cache.updateBundle(out);
        signal(out);
        return out;
    }

    @Override
    public WriteBundle redraftStep(Who who, long id, int step, Map<String, String> changes, boolean drop) {
        if (who != Who.CLAUDE) {
            throw TeamException.userOnly("The user changes a bundle by editing it; redraft is Claude's");
        }
        if (!claudeMayDraft()) {
            throw TeamException.userOnly("The user turned off Claude's Azure changes (Settings ▸ Team)");
        }
        WriteBundle b = waiting(id);
        if (Who.USER.name().equals(b.origin())) {
            throw TeamException.userOnly("Claude redrafts only a bundle Claude or Alfred prepared");
        }
        if (step < 0 || step >= b.steps().size()) {
            throw TeamException.invalid("No step " + (step + 1));
        }
        List<WriteStep> steps = new ArrayList<>(b.steps());
        if (drop) {
            if (steps.size() == 1) {
                throw TeamException.invalid("A bundle keeps at least one step - the user rejects the whole bundle");
            }
            for (int i = step; i < steps.size(); i++) {
                if (steps.get(i).kind() == StepKind.ATTACH && cache.bundleFile(id, i).isPresent()) {
                    throw TeamException.invalid("Step " + (i + 1) + " has a built file - drop the steps after it first");
                }
            }
            steps.remove(step);
        } else {
            WriteStep s = steps.get(step);
            if (changes == null || changes.isEmpty()) {
                throw TeamException.invalid("Name what to change in the step");
            }
            Map<String, String> p = withoutCheck(s.payload());
            for (Map.Entry<String, String> e : changes.entrySet()) {
                if (e.getValue() == null) {
                    p.remove(e.getKey());
                } else {
                    p.put(e.getKey(), e.getValue());
                }
            }
            // what it changes now is read again: the old "before" values belong to the old draft
            for (String k : List.of("from", "fromFields", "fromParent", "fromState", "fromTags")) {
                p.remove(k);
            }
            if (s.kind() == StepKind.COMMENT && changes.containsKey("text")) {
                p.putIfAbsent("draft", s.payload().getOrDefault("text", ""));
                p.put("previous", s.payload().getOrDefault("text", ""));
                p.put("redraftedAt", clock.instant().toString());
            }
            WriteStep next = new WriteStep(s.kind(), p, s.ticked(), false, null);
            check(List.of(next));
            next = annotate(b.conn(), b.item(), List.of(next), who).get(0);
            check(List.of(next));
            steps.set(step, dryRun(b.conn(), b.item(), List.of(next), step, true).get(0));
        }
        check(steps);
        WriteBundle out = new WriteBundle(b.id(), b.boardId(), b.cardId(), b.conn(), b.item(), b.origin(), b.askedIn(), b.title(), steps,
                WriteState.WAITING, b.createdAt(), null, null, b.note());
        cache.updateBundle(out);
        signal(out);
        return out;
    }

    @Override
    public Optional<Long> askRedraft(long id, int step, String instruction) {
        WriteBundle b = waiting(id);
        if (step < 0 || step >= b.steps().size() || b.steps().get(step).kind() != StepKind.COMMENT) {
            throw TeamException.invalid("Step " + (step + 1) + " is not a comment step");
        }
        String ask = instruction == null ? "" : instruction.strip().replaceAll("\\s+", " ");
        if (ask.isEmpty() || ask.length() > 2000) {
            throw TeamException.invalid("Say in 1 to 2000 characters how to change it");
        }
        TeamBoardsPort port = boards.getIfAvailable();
        if (port == null || b.boardId() == null) {
            throw TeamException.invalid("This bundle is on no board - ask Claude in a chat instead");
        }
        String project = port.projectOf(b.boardId()).orElseThrow(() -> TeamException.notFound("No board " + b.boardId()));
        String item = b.item() == null ? "a new item" : "AB#" + b.item();
        return port.postStart(project, b.boardId(), "/alfred-team redraft bundle " + id + " step " + (step + 1) + " (" + item + "): " + ask);
    }

    // ------------------------------------------------------------------------------------------------------- retry

    @Override
    public WriteBundle retry(Who who, long id, int step) {
        decider(who, "sends to the tracker");
        WriteBundle b = get(id).orElseThrow(() -> TeamException.notFound("No bundle " + id));
        if (b.state() != WriteState.PARTIAL) {
            throw new TeamException(Code.CONFLICT, "Bundle " + id + " is " + b.state() + " - only a step that failed is sent again");
        }
        if (step < 0 || step >= b.steps().size()) {
            throw TeamException.invalid("No step " + (step + 1));
        }
        WriteStep s = b.steps().get(step);
        if (!s.ticked() || s.result() == null || s.result().ok()) {
            throw TeamException.invalid("Step " + (step + 1) + " did not fail");
        }
        if (b.item() == null) {
            throw TeamException.invalid("No item: the create step did not run");
        }
        Ctx c = live.ctx(b.conn());
        StepResult r;
        try {
            r = step(c, b, step, s, b.item());
        } catch (TeamException e) {
            if (e.code() == Code.TOKEN_REJECTED || e.code() == Code.TOKEN_MISSING) {
                throw e; // nothing changes: enter the token and retry
            }
            r = new StepResult(false, e.getMessage(), null);
        } catch (RuntimeException e) {
            r = new StepResult(false, "Not sent: " + e.getClass().getSimpleName(), null);
        }
        List<WriteStep> steps = new ArrayList<>(b.steps());
        steps.set(step, new WriteStep(s.kind(), s.payload(), s.ticked(), s.unmasked(), r));
        boolean allOk = steps.stream().filter(WriteStep::ticked).allMatch(x -> x.result() != null && x.result().ok());
        WriteBundle out = new WriteBundle(b.id(), b.boardId(), b.cardId(), b.conn(), b.item(), b.origin(), b.askedIn(), b.title(), steps,
                allOk ? WriteState.DONE : WriteState.PARTIAL, b.createdAt(), b.decidedAt(), b.decidedBy());
        cache.updateBundle(out);
        signal(out);
        return out;
    }

    // --------------------------------------------------------------------------------------------------------- run

    /** Runs the ticked steps in order; each gets its result. A failed CREATE stops the steps that need its item. */
    WriteBundle run(Ctx c, WriteBundle b) {
        List<WriteStep> steps = new ArrayList<>(b.steps());
        String item = b.item();
        boolean failed = false;
        boolean tokenStop = false;
        for (int i = 0; i < steps.size(); i++) {
            WriteStep s = steps.get(i);
            if (!s.ticked()) {
                continue;
            }
            StepResult r;
            try {
                if (target(s, item) == null && s.kind() != StepKind.CREATE) {
                    r = new StepResult(false, "No item: the create step did not run", null);
                } else {
                    r = step(c, b, i, s, s.kind() == StepKind.CREATE ? item : target(s, item));
                    if (s.kind() == StepKind.CREATE && r.ok()) {
                        item = r.azureId();
                    }
                }
            } catch (TeamException e) {
                r = new StepResult(false, e.getMessage(), null);
                if (e.code() == Code.TOKEN_REJECTED || e.code() == Code.TOKEN_MISSING) {
                    // the rest would fail the same way: they are left unsent for another approve
                    steps.set(i, new WriteStep(s.kind(), s.payload(), s.ticked(), s.unmasked(), r));
                    tokenStop = true;
                    break;
                }
            } catch (RuntimeException e) {
                r = new StepResult(false, "Not sent: " + e.getClass().getSimpleName(), null);
            }
            failed |= !r.ok();
            steps.set(i, new WriteStep(s.kind(), s.payload(), s.ticked(), s.unmasked(), r));
            cache.updateBundle(new WriteBundle(b.id(), b.boardId(), b.cardId(), b.conn(), item, b.origin(), b.askedIn(), b.title(), steps,
                    WriteState.SENDING, b.createdAt(), b.decidedAt(), b.decidedBy()));
        }
        if (tokenStop) {
            // the token went: the bundle waits again - what was sent unticked, its files kept - for the next approve
            List<WriteStep> left = new ArrayList<>();
            for (WriteStep s : steps) {
                boolean sent = s.result() != null && s.result().ok();
                left.add(new WriteStep(s.kind(), s.payload(), s.ticked() && !sent, s.unmasked(), s.result()));
            }
            WriteBundle again = new WriteBundle(b.id(), b.boardId(), b.cardId(), b.conn(), item, b.origin(), b.askedIn(), b.title(), left,
                    WriteState.WAITING, b.createdAt(), null, null);
            cache.updateBundle(again);
            signal(again);
            return again;
        }
        WriteBundle out = new WriteBundle(b.id(), b.boardId(), b.cardId(), b.conn(), item, b.origin(), b.askedIn(), b.title(), steps,
                failed ? WriteState.PARTIAL : WriteState.DONE, b.createdAt(), b.decidedAt() == null ? clock.instant() : b.decidedAt(),
                b.decidedBy() == null ? "user" : b.decidedBy());
        cache.updateBundle(out);
        cache.deleteBundleFiles(b.id());
        signal(out);
        return out;
    }

    private StepResult step(Ctx c, WriteBundle b, int index, WriteStep s, String item) {
        Map<String, String> p = s.payload();
        return switch (s.kind()) {
            case STATE -> {
                ItemWriter w = live.cap(c, ItemWriter.class, "change a state");
                live.call(c, () -> {
                    w.moveState(c.connection(), c.token(), item, p.get("state").strip());
                    return null;
                });
                yield new StepResult(true, "State is now " + p.get("state").strip(), null);
            }
            case COMMENT -> {
                ItemWriter w = live.cap(c, ItemWriter.class, "comment");
                // "via Alfred" only when asked for (specs/038 FR-12): the user decides whether Azure hears of Alfred
                String text = p.get("text") + ("1".equals(p.get("footer")) ? footer(b) : "");
                String id = live.call(c, () -> w.comment(c.connection(), c.token(), item, text));
                markLink(b, item, l -> new CardLinkRow(l.cardId(), l.boardId(), l.conn(), l.item(), l.linkedAt(), l.linkedBy(), l.hyperlink(), l.tag(),
                        id), "comment".equals(p.get("marker")));
                yield new StepResult(true, "Comment added", id);
            }
            case ATTACH -> {
                AttachmentWriter w = live.cap(c, AttachmentWriter.class, "attach files");
                byte[] data = cache.bundleFile(b.id(), index).orElseThrow(() -> TeamException.invalid("No file for step " + (index + 1)));
                String name = p.get("name");
                live.call(c, () -> {
                    w.attach(c.connection(), c.token(), item, name, data);
                    return null;
                });
                yield new StepResult(true, name + " attached (" + data.length + " bytes)", null);
            }
            case HYPERLINK, UNHYPERLINK -> {
                ItemWriter w = live.cap(c, ItemWriter.class, "link");
                boolean add = s.kind() == StepKind.HYPERLINK;
                live.call(c, () -> {
                    w.hyperlink(c.connection(), c.token(), item, URI.create(p.get("url").strip()), p.getOrDefault("label", "Alfred"), add);
                    return null;
                });
                markLink(b, item, l -> new CardLinkRow(l.cardId(), l.boardId(), l.conn(), l.item(), l.linkedAt(), l.linkedBy(), add, l.tag(),
                        l.commentId()), true);
                yield new StepResult(true, add ? "Link back to Alfred added" : "Link back to Alfred removed", null);
            }
            case FIELD -> {
                ItemWriter w = live.cap(c, ItemWriter.class, "set a field");
                if (StepPayloads.isEdit(p)) {
                    ItemUpdate u = StepPayloads.update(p);
                    live.call(c, () -> {
                        w.update(c.connection(), c.token(), item, u);
                        return null;
                    });
                    yield new StepResult(true, editSummary(u) + " on " + item, null);
                }
                String field = p.get("field").strip();
                String value = p.getOrDefault("value", "");
                live.call(c, () -> {
                    w.setField(c.connection(), c.token(), item, field, value);
                    return null;
                });
                yield new StepResult(true, value.isBlank() ? field + " cleared" : field + " is now " + value, null);
            }
            case TAG, UNTAG -> {
                ItemWriter w = live.cap(c, ItemWriter.class, "tag");
                boolean add = s.kind() == StepKind.TAG;
                live.call(c, () -> {
                    w.tag(c.connection(), c.token(), item, p.get("tag").strip(), add);
                    return null;
                });
                markLink(b, item, l -> new CardLinkRow(l.cardId(), l.boardId(), l.conn(), l.item(), l.linkedAt(), l.linkedBy(), l.hyperlink(), add,
                        l.commentId()), "alfred".equalsIgnoreCase(p.get("tag").strip()));
                yield new StepResult(true, (add ? "Tagged " : "Untagged ") + p.get("tag").strip(), null);
            }
            case CREATE -> {
                ItemWriter w = live.cap(c, ItemWriter.class, "create items");
                NewItem n = StepPayloads.newItem(p);
                String id = live.call(c, () -> w.create(c.connection(), c.token(), n));
                if (b.cardId() != null) {
                    CardItemsUseCase ci = cardItems.getIfAvailable();
                    if (ci != null) {
                        ci.linkInAlfred(b.cardId(), b.conn(), id, "user");
                    }
                }
                yield new StepResult(true, n.type() + " " + id + " created" + (n.parent() == null ? "" : " under " + n.parent())
                        + (n.fields().isEmpty() ? "" : " with " + String.join(", ", n.fields().keySet().stream().map(f -> f.substring(f.lastIndexOf('.') + 1)).toList())),
                        id);
            }
            case LINK_ALFRED -> {
                if (p.get("card") != null) {
                    CardItemsUseCase ci = cardItems.getIfAvailable();
                    if (ci == null) {
                        yield new StepResult(false, "Cards are not wired in this Alfred", null);
                    }
                    ci.linkInAlfred(p.get("card"), b.conn(), item, "user");
                    yield new StepResult(true, "Linked to card " + p.get("card") + " in Alfred", null);
                }
                BoardItemsUseCase bi = boardItems.getIfAvailable();
                if (bi == null) {
                    yield new StepResult(false, "Boards are not wired in this Alfred", null);
                }
                bi.add(Who.USER, p.get("board"), b.conn(), item, "1".equals(p.get("asMain")), BoardItemsUseCase.MAX_REFS, null);
                yield new StepResult(true, "Added to board " + p.get("board") + " in Alfred", null);
            }
        };
    }

    /** "Activity, OriginalEstimate set · parent 62555 · +1 link · tags" - what an edit changed, for its result line. */
    static String editSummary(ItemUpdate u) {
        List<String> out = new ArrayList<>();
        if (!u.fields().isEmpty()) {
            out.add(String.join(", ", u.fields().keySet().stream().map(f -> f.substring(f.lastIndexOf('.') + 1)).toList()) + " set");
        }
        if (u.state() != null) {
            out.add("state " + u.state());
        }
        if (u.parent() != null) {
            out.add(u.parent().isBlank() ? "parent removed" : "parent " + u.parent());
        }
        if (!u.addLinks().isEmpty() || !u.removeLinks().isEmpty()) {
            out.add("+" + u.addLinks().size() + " / -" + u.removeLinks().size() + " links");
        }
        if (!u.addTags().isEmpty() || !u.removeTags().isEmpty()) {
            out.add("tags");
        }
        return String.join(" · ", out);
    }

    private void markLink(WriteBundle b, String item, java.util.function.UnaryOperator<CardLinkRow> change, boolean applies) {
        if (!applies || b.cardId() == null) {
            return;
        }
        for (CardLinkRow l : cache.cardLinks(b.cardId())) {
            if (l.conn().equals(b.conn()) && l.item().equals(item)) {
                cache.putCardLink(change.apply(l));
            }
        }
    }

    /** "via Alfred: board …" (FR-076), with a link to the board when the public address is set. */
    String footer(WriteBundle b) {
        if (b.boardId() == null) {
            return "\n\n_via Alfred_";
        }
        TeamBoardsPort port = boards.getIfAvailable();
        String name = port == null ? b.boardId() : port.boardName(b.boardId()).orElse(b.boardId());
        String card = "";
        if (b.cardId() != null && port != null) {
            // "card 72", never "#72": Azure links #72 to its own work item 72
            card = port.card(b.cardId()).map(x -> " · card " + x.number() + " " + x.title()).orElse("");
        }
        String address = cache.hook(b.conn()).map(HookRow::publicAddress).filter(a -> a != null && !a.isBlank()).orElse(null);
        String link = address == null ? "" : " - " + address.replaceAll("/+$", "") + "/board?board=" + enc(b.boardId())
                + (b.cardId() == null ? "" : "&card=" + enc(b.cardId()));
        return "\n\n_via Alfred: board " + name + card + "_" + link;
    }

    private static String enc(String s) {
        return java.net.URLEncoder.encode(s, java.nio.charset.StandardCharsets.UTF_8);
    }

    private void signal(WriteBundle b) {
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("id", b.id());
        extra.put("state", b.state().name());
        if (b.cardId() != null) {
            extra.put("card", b.cardId());
        }
        signals.board(b.boardId(), b.conn(), "write", extra);
    }

    // ------------------------------------------------------------------------------------------------- tell Azure

    @Override
    public void cardStatusChanged(String cardId, String boardId, String from, String to, String resolution, Who who) {
        List<CardLinkRow> links = cache.cardLinks(cardId);
        if (links.isEmpty() || who != Who.USER) {
            return;
        }
        TeamBoardsPort port = boards.getIfAvailable();
        Optional<CardInfo> card = port == null ? Optional.empty() : port.card(cardId);
        String label = card.map(c -> "#" + c.number() + " " + c.title()).orElse("card " + cardId);
        for (CardLinkRow l : links) {
            if (cache.bundles(null, cardId, WriteState.WAITING.name(), 50).stream().anyMatch(x -> l.item().equals(x.item()) && x.origin().equals("ALFRED"))) {
                continue; // one prepared bundle per item at a time
            }
            List<WriteStep> steps = new ArrayList<>();
            String title;
            if ("VERIFIED".equals(to) || "DONE".equals(to)) {
                String target = targetState(l.conn(), l.item(), "VERIFIED".equals(to) ? "Resolved" : "Completed");
                if (target != null) {
                    steps.add(new WriteStep(StepKind.STATE, Map.of("state", target), true, false, null));
                }
                steps.add(new WriteStep(StepKind.COMMENT, Map.of("text", ("VERIFIED".equals(to) ? "Verified" : "Done") + " in Alfred: " + label + "."),
                        true, false, null));
                steps.add(new WriteStep(StepKind.ATTACH, Map.of("name", "evidence.html", "what", "export", "card", cardId), false, false, null));
                title = "Tell Azure: " + label + " is " + ("VERIFIED".equals(to) ? "verified" : "done");
            } else if ("CLOSED".equals(to) && "NOT_IN_FLOW".equals(resolution)) {
                steps.addAll(cleanup(cache, l, cardId));
                if (steps.isEmpty()) {
                    continue;
                }
                title = "Clean up in Azure: " + label + " was closed as not in this flow";
            } else {
                continue;
            }
            WriteBundle b = new WriteBundle(0, l.boardId() == null ? boardId : l.boardId(), cardId, l.conn(), l.item(), "ALFRED", null, title, steps,
                    WriteState.WAITING, clock.instant(), null, null);
            long id = cache.insertBundle(b);
            get(id).ifPresent(this::signal);
        }
    }

    /** What removing a link undoes in the tracker: the hyperlink, the tag when no other card links it, and a comment. */
    static List<WriteStep> cleanup(TeamCachePort cache, CardLinkRow l, String cardId) {
        List<WriteStep> steps = new ArrayList<>();
        if (l.hyperlink()) {
            String address = cache.hook(l.conn()).map(HookRow::publicAddress).orElse(null);
            if (address != null && !address.isBlank()) {
                steps.add(new WriteStep(StepKind.UNHYPERLINK, Map.of("url", address.replaceAll("/+$", "") + "/board?board=" + enc(String.valueOf(l.boardId()))
                        + "&card=" + enc(cardId)), true, false, null));
            }
        }
        boolean others = cache.cardLinksOfItem(l.conn(), l.item()).stream().anyMatch(o -> !o.cardId().equals(cardId));
        if (l.tag() && !others) {
            steps.add(new WriteStep(StepKind.UNTAG, Map.of("tag", "alfred"), true, false, null));
        }
        steps.add(new WriteStep(StepKind.COMMENT, Map.of("text", "No longer followed in Alfred."), false, false, null));
        return steps;
    }

    /** The first state of the item's type in a category (Resolved, Completed) - the process's own name for it. */
    String targetState(String conn, String item, String category) {
        String type = cache.copy(conn, item).flatMap(Copies::item).map(Item::type).orElse(null);
        String fallback = null;
        for (StateRow s : cache.states(conn)) {
            if (category.equalsIgnoreCase(s.category())) {
                if (type != null && type.equalsIgnoreCase(s.type())) {
                    return s.name();
                }
                fallback = fallback == null ? s.name() : fallback;
            }
        }
        if (fallback == null && "Resolved".equals(category)) {
            return targetState(conn, item, "Completed");
        }
        return fallback;
    }
}
