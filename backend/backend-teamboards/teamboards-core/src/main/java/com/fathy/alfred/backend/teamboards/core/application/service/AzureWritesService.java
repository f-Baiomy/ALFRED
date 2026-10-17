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
import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamChangeSignalPort;
import com.fathy.alfred.backend.teamboards.core.application.service.Live.Ctx;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.CardLinkRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.StateRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.StepKind;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.StepResult;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WriteBundle;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WriteState;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WriteStep;
import com.fathy.alfred.backend.teamboards.spi.AttachmentWriter;
import com.fathy.alfred.backend.teamboards.spi.ItemWriter;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.NewItem;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
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
                case STATE -> need(p, "state");
                case COMMENT -> need(p, "text");
                case ATTACH -> need(p, "name");
                case HYPERLINK, UNHYPERLINK -> need(p, "url");
                case TAG, UNTAG -> need(p, "tag");
                case CREATE -> need(p, "type") != null ? "type" : need(p, "title");
                case LINK_ALFRED -> p.get("card") == null && p.get("board") == null ? "card or board" : null;
                case FIELD -> need(p, "field");
            };
            if (s.kind() == StepKind.FIELD) {
                String f = p.get("field").strip();
                if (!FIELD_NAME.matcher(f).matches() || NOT_A_FIELD_WRITE.contains(f.toLowerCase(java.util.Locale.ROOT))) {
                    throw TeamException.invalid("Set " + f + " another way: a field step takes a field's reference name (e.g. "
                            + "Microsoft.VSTS.Common.Priority), not the state, id, revision or a date the tracker keeps");
                }
            }
            if (missing != null) {
                throw TeamException.invalid(s.kind() + " needs " + missing);
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
        check(in.steps());
        if (in.title() == null || in.title().isBlank() || in.title().length() > 300) {
            throw TeamException.invalid("A bundle's title is 1 to 300 characters");
        }
        boolean creates = in.steps().stream().anyMatch(s -> s.kind() == StepKind.CREATE);
        if (!creates && (in.item() == null || in.item().isBlank())) {
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
            for (WriteStep s : in.steps()) {
                steps.add(fresh(s, who));
            }
            check(steps);
            WriteBundle next = new WriteBundle(old.id(), old.boardId(), old.cardId(), old.conn(), old.item(), old.origin(), old.askedIn(), old.title(),
                    steps, WriteState.WAITING, old.createdAt(), null, null);
            cache.updateBundle(next);
            signal(next);
            return next;
        }
        List<WriteStep> steps = in.steps().stream().map(s -> fresh(s, who)).toList();
        WriteBundle b = new WriteBundle(0, blank(in.boardId()), blank(in.cardId()), in.conn(), blank(in.item()), who.name(), blank(in.askedIn()),
                in.title().strip(), steps, WriteState.WAITING, clock.instant(), null, null);
        long id = cache.insertBundle(b);
        WriteBundle saved = get(id).orElse(b);
        signal(saved);
        return saved;
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
        check(steps);
        Ctx c = live.ctx(conn);
        List<WriteStep> ticked = steps.stream().map(s -> new WriteStep(s.kind(), s.payload(), true, s.unmasked(), null)).toList();
        WriteBundle b = new WriteBundle(0, blank(boardId), blank(cardId), conn, blank(item), Who.USER.name(), null,
                title == null || title.isBlank() ? "Your change in " + c.stored().name() : title.strip(), ticked, WriteState.SENDING, clock.instant(),
                clock.instant(), "user");
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
        if (who != Who.USER) {
            throw TeamException.userOnly("Only the user edits a bundle - Claude extends it (extend) or starts another");
        }
        WriteBundle b = waiting(id);
        List<WriteStep> next = new ArrayList<>(steps == null ? b.steps()
                : steps.stream().map(s -> new WriteStep(s.kind(), s.payload(), s.ticked(), s.unmasked(), null)).toList());
        check(next);
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
        if (who != Who.USER) {
            throw TeamException.userOnly("Only the user approves what goes to the tracker");
        }
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
        WriteBundle sending = new WriteBundle(b.id(), b.boardId(), b.cardId(), b.conn(), b.item(), b.origin(), b.askedIn(), b.title(), b.steps(),
                WriteState.SENDING, b.createdAt(), clock.instant(), "user");
        if (!cache.claimSending(id, sending.decidedAt(), "user")) {
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
        if (who != Who.USER) {
            throw TeamException.userOnly("Only the user rejects a bundle - Claude may withdraw by proposing again");
        }
        WriteBundle b = waiting(id);
        WriteBundle out = new WriteBundle(b.id(), b.boardId(), b.cardId(), b.conn(), b.item(), b.origin(), b.askedIn(), b.title(), b.steps(),
                WriteState.REJECTED, b.createdAt(), clock.instant(), "user");
        cache.updateBundle(out);
        cache.deleteBundleFiles(id);
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
                if (item == null && s.kind() != StepKind.CREATE) {
                    r = new StepResult(false, "No item: the create step did not run", null);
                } else {
                    r = step(c, b, i, s, item);
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
                String text = p.get("text") + footer(b);
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
                NewItem n = new NewItem(p.get("project"), p.get("type").strip(), p.get("title").strip(), p.get("description"), p.get("area"),
                        p.get("iteration"), p.get("assignee"), p.get("parent"));
                String id = live.call(c, () -> w.create(c.connection(), c.token(), n));
                if (b.cardId() != null) {
                    CardItemsUseCase ci = cardItems.getIfAvailable();
                    if (ci != null) {
                        ci.linkInAlfred(b.cardId(), b.conn(), id, "user");
                    }
                }
                yield new StepResult(true, n.type() + " " + id + " created", id);
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
            card = port.card(b.cardId()).map(x -> " · card #" + x.number() + " " + x.title()).orElse("");
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
