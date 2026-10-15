package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.CycleRemovedUseCase;
import com.fathy.alfred.backend.board.application.port.in.ManageBriefUseCase;
import com.fathy.alfred.backend.board.application.port.in.ManageSpecFilesUseCase;
import com.fathy.alfred.backend.board.application.port.in.MarkChecklistUseCase;
import com.fathy.alfred.backend.board.application.port.in.SuggestMarkUseCase;
import com.fathy.alfred.backend.board.application.port.in.SessionLogUseCase;
import com.fathy.alfred.backend.board.application.port.in.TestStepsUseCase;
import com.fathy.alfred.backend.board.domain.model.CardRef;
import com.fathy.alfred.backend.board.domain.model.SessionLogEntry;
import com.fathy.alfred.backend.board.domain.model.StepState;
import com.fathy.alfred.backend.board.domain.model.TestStep;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.application.port.out.MentionedCallsChangedPort;
import com.fathy.alfred.backend.board.domain.AcceptanceItems;
import com.fathy.alfred.backend.board.domain.ClaudeRules;
import com.fathy.alfred.backend.board.domain.MentionParser;
import com.fathy.alfred.backend.board.domain.RichText;
import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.ActivityKind;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.ChecklistFile;
import com.fathy.alfred.backend.board.domain.model.ChecklistItem;
import com.fathy.alfred.backend.board.domain.model.ChecklistMark;
import com.fathy.alfred.backend.board.domain.model.ChecklistSuggestion;
import com.fathy.alfred.backend.board.domain.model.CycleBrief;
import com.fathy.alfred.backend.board.domain.model.Mark;
import com.fathy.alfred.backend.board.domain.model.MentionOwner;
import com.fathy.alfred.backend.board.domain.model.MentionRef;
import com.fathy.alfred.backend.board.domain.model.SpecFile;
import com.fathy.alfred.backend.board.domain.model.SpecFileInfo;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * What a session cycle is for: its brief, its spec files and the acceptance checklist marked on them (specs/014 US5,
 * US9). Claude reads these; only the user writes them.
 */
@Service
public class CycleBriefService implements ManageBriefUseCase, ManageSpecFilesUseCase, MarkChecklistUseCase, SuggestMarkUseCase,
        CycleRemovedUseCase, SessionLogUseCase, TestStepsUseCase {

    static final int MAX_NAME = 200;

    private final BoardStorePort store;
    private final BoardNotificationPort notifications;
    private final MentionedCallsChangedPort mentionedCalls;
    private final Clock clock;

    @Autowired
    public CycleBriefService(BoardStorePort store, BoardNotificationPort notifications, MentionedCallsChangedPort mentionedCalls,
                             BoardChangeFeed feed) {
        this(store, notifications, mentionedCalls, feed, Clock.systemUTC());
    }

    CycleBriefService(BoardStorePort store, BoardNotificationPort notifications, MentionedCallsChangedPort mentionedCalls,
                      BoardChangeFeed feed, Clock clock) {
        this.store = store;
        this.notifications = feed.feeding(notifications);
        this.mentionedCalls = mentionedCalls;
        this.clock = clock;
    }

    // ------------------------------------------------------------------------------------------------------------ brief

    @Override
    public CycleBrief brief(String cycleId) {
        return store.brief(cycleId).orElse(new CycleBrief(cycleId, "", null));
    }

    @Override
    public BriefOutcome putBrief(Actor actor, String cycleId, String text) {
        // Claude may write it too (specs/015, /alfred-setup and /alfred-spec ask the user first); the author is recorded and
        // the replaced text kept for Restore previous.
        String clean = text == null ? "" : RichText.clean(text);
        if (clean.length() > ManageBriefUseCase.MAX_TEXT) {
            return new BriefOutcome(CardChange.Outcome.INVALID, null, "The brief is larger than 256 KB");
        }
        List<MentionRef> before = store.mentionsOf(MentionOwner.BRIEF, cycleId).stream().map(m -> m.ref()).toList();
        store.putBrief(new CycleBrief(cycleId, clean, clock.instant(), actor, false));
        CycleBrief brief = brief(cycleId);
        List<MentionRef> after = MentionParser.mentions(clean);
        store.replaceMentions(MentionOwner.BRIEF, cycleId, null, after);
        store.attachImages(RichText.imageIds(clean), null, cycleId);
        if (hasLiveCall(before) || hasLiveCall(after)) {
            mentionedCalls.mentionedCallsChanged();
        }
        notifications.changed(null, cycleId, null, "brief");
        return new BriefOutcome(CardChange.Outcome.OK, brief, null);
    }

    // ------------------------------------------------------------------------------------------------------- spec files

    @Override
    public List<SpecFileInfo> specs(String cycleId) {
        return store.specs(cycleId);
    }

    @Override
    public Optional<SpecFile> spec(String cycleId, String name) {
        return store.spec(cycleId, name);
    }

    @Override
    public SpecOutcome put(Actor actor, String cycleId, String name, String content) {
        String problem = checkName(name);
        if (problem != null) {
            return new SpecOutcome(CardChange.Outcome.INVALID, null, false, problem);
        }
        String text = content == null ? "" : RichText.clean(content);
        long size = text.getBytes(StandardCharsets.UTF_8).length;
        if (size > ManageSpecFilesUseCase.MAX_BYTES) {
            return new SpecOutcome(CardChange.Outcome.INVALID, null, false, "A spec file can be at most 5 MB");
        }
        boolean exists = store.spec(cycleId, name).isPresent();
        if (!exists && store.specs(cycleId).size() >= ManageSpecFilesUseCase.MAX_FILES) {
            return new SpecOutcome(CardChange.Outcome.INVALID, null, false,
                    "A cycle can hold at most " + ManageSpecFilesUseCase.MAX_FILES + " spec files");
        }
        Instant now = clock.instant();
        SpecFile file = new SpecFile(cycleId, name, text, size, now, actor);
        boolean replaced = store.putSpec(file);
        if (replaced) {
            for (String cardId : store.cardsMentioningSpec(cycleId, name)) {
                store.append(new ActivityEntry(0, cardId, actor, ActivityKind.SPEC_REPLACED, null, null, name, now));
            }
        }
        notifications.changed(null, cycleId, null, "specs");
        return new SpecOutcome(CardChange.Outcome.OK, new SpecFileInfo(name, size, now, actor, replaced), replaced, null);
    }

    @Override
    public BriefOutcome restoreBrief(Actor actor, String cycleId) {
        if (actor == Actor.CLAUDE) {
            return new BriefOutcome(CardChange.Outcome.REFUSED_FOR_CLAUDE, null, ClaudeRules.USER_ONLY);
        }
        if (!store.restoreBrief(cycleId, clock.instant())) {
            return new BriefOutcome(CardChange.Outcome.NOT_FOUND, null, "No earlier brief to restore");
        }
        store.replaceMentions(MentionOwner.BRIEF, cycleId, null, MentionParser.mentions(brief(cycleId).text()));
        mentionedCalls.mentionedCallsChanged();
        notifications.changed(null, cycleId, null, "brief");
        return new BriefOutcome(CardChange.Outcome.OK, brief(cycleId), null);
    }

    @Override
    public SpecOutcome restore(Actor actor, String cycleId, String name) {
        if (actor == Actor.CLAUDE) {
            return new SpecOutcome(CardChange.Outcome.REFUSED_FOR_CLAUDE, null, false, ClaudeRules.USER_ONLY);
        }
        if (!store.restoreSpec(cycleId, name, clock.instant())) {
            return new SpecOutcome(CardChange.Outcome.NOT_FOUND, null, false, "No earlier version of " + name + " to restore");
        }
        notifications.changed(null, cycleId, null, "specs");
        SpecFileInfo info = store.specs(cycleId).stream().filter(s -> s.name().equals(name)).findFirst().orElse(null);
        return new SpecOutcome(CardChange.Outcome.OK, info, true, null);
    }

    @Override
    public CardChange.Outcome delete(Actor actor, String cycleId, String name) {
        if (actor == Actor.CLAUDE) {
            return CardChange.Outcome.REFUSED_FOR_CLAUDE;
        }
        if (!store.deleteSpec(cycleId, name)) {
            return CardChange.Outcome.NOT_FOUND;
        }
        notifications.changed(null, cycleId, null, "specs");
        return CardChange.Outcome.OK;
    }

    /** A plain name: .md or .txt, no folders, nothing that could leave the cycle. */
    static String checkName(String name) {
        if (name == null || name.isBlank() || name.length() > MAX_NAME) {
            return "A spec file needs a name of 1 to " + MAX_NAME + " characters";
        }
        if (name.contains("/") || name.contains("\\") || name.contains("..") || name.chars().anyMatch(Character::isISOControl)) {
            return "A spec file name cannot contain / \\ or ..";
        }
        String lower = name.toLowerCase(Locale.ROOT);
        if (!lower.endsWith(".md") && !lower.endsWith(".txt")) {
            return "Only .md and .txt spec files are accepted";
        }
        return null;
    }

    // -------------------------------------------------------------------------------------------------------- checklist

    @Override
    public List<ChecklistFile> checklist(String cycleId) {
        Map<String, ChecklistMark> marks = store.marks(cycleId).stream()
                .collect(Collectors.toMap(m -> m.fileName() + "\n" + m.itemKey(), Function.identity(), (a, b) -> a));
        Map<String, List<CardRef>> cards = store.cardsBySpecItem(cycleId);
        Map<String, ChecklistSuggestion> suggestions = store.suggestions(cycleId).stream()
                .collect(Collectors.toMap(m -> m.fileName() + "\n" + m.itemKey(), Function.identity(), (a, b) -> a));
        List<ChecklistFile> out = new ArrayList<>();
        for (SpecFileInfo info : store.specs(cycleId)) {
            Optional<SpecFile> file = store.spec(cycleId, info.name());
            if (file.isEmpty()) {
                continue;
            }
            List<ChecklistItem> items = AcceptanceItems.of(file.get().content()).stream()
                    .map(i -> new ChecklistItem(i.key(), i.text(), marks.get(info.name() + "\n" + i.key()),
                            suggestions.get(info.name() + "\n" + i.key()), cards.get(info.name() + "\n" + i.key()))).toList();
            if (!items.isEmpty()) {
                out.add(new ChecklistFile(info.name(), items));
            }
        }
        return out;
    }

    @Override
    public MarkOutcome mark(Actor actor, String cycleId, String fileName, String itemKey, Mark mark, String evidence) {
        if (actor == Actor.CLAUDE) {
            return new MarkOutcome(CardChange.Outcome.REFUSED_FOR_CLAUDE, null, ClaudeRules.USER_ONLY);
        }
        if (mark == null) {
            return new MarkOutcome(CardChange.Outcome.INVALID, null, "mark is required");
        }
        String cleanEvidence = evidence == null ? "" : evidence;
        if (cleanEvidence.length() > MarkChecklistUseCase.MAX_EVIDENCE) {
            return new MarkOutcome(CardChange.Outcome.INVALID, null, "evidence is larger than 8 KB");
        }
        Optional<SpecFile> file = store.spec(cycleId, fileName);
        Optional<AcceptanceItems.Item> item = file.flatMap(f -> AcceptanceItems.of(f.content()).stream()
                .filter(i -> i.key().equals(itemKey)).findFirst());
        if (item.isEmpty()) {
            return new MarkOutcome(CardChange.Outcome.NOT_FOUND, null, "No such acceptance item");
        }
        Instant now = clock.instant();
        Optional<ChecklistMark> previous = store.mark(cycleId, fileName, itemKey);
        List<ChecklistMark.Change> history = new ArrayList<>(previous.map(ChecklistMark::history).orElse(List.of()));
        if (previous.isEmpty() || previous.get().mark() != mark) {
            history.add(new ChecklistMark.Change(mark, actor, now));
        }
        ChecklistMark next = new ChecklistMark(cycleId, fileName, itemKey, mark, actor, cleanEvidence, history, now);
        store.putMark(next);
        // The user's own mark answers any suggestion on the item.
        store.deleteSuggestion(cycleId, fileName, itemKey);
        List<MentionRef> refs = MentionParser.mentions(cleanEvidence);
        String owner = cycleId + "/" + fileName + "/" + itemKey;
        boolean hadLive = hasLiveCall(store.mentionsOf(MentionOwner.CHECKLIST, owner).stream().map(m -> m.ref()).toList());
        store.replaceMentions(MentionOwner.CHECKLIST, owner, null, refs);
        if (hadLive || hasLiveCall(refs)) {
            mentionedCalls.mentionedCallsChanged();
        }
        notifications.changed(null, cycleId, null, "checklist");
        return new MarkOutcome(CardChange.Outcome.OK, new ChecklistItem(itemKey, item.get().text(), next), null);
    }

    // ---------------------------------------------------------------------------------------------- suggested marks

    @Override
    public MarkOutcome suggest(Actor actor, String cycleId, String fileName, String itemKey, Mark mark, String evidence) {
        if (actor != Actor.CLAUDE) {
            return new MarkOutcome(CardChange.Outcome.INVALID, null, "Mark the item yourself - suggestions are Claude's");
        }
        if (mark == null) {
            return new MarkOutcome(CardChange.Outcome.INVALID, null, "mark is required");
        }
        String cleanEvidence = evidence == null ? "" : RichText.clean(evidence.strip());
        if (cleanEvidence.length() > MarkChecklistUseCase.MAX_EVIDENCE) {
            return new MarkOutcome(CardChange.Outcome.INVALID, null, "evidence is larger than 8 KB");
        }
        Optional<AcceptanceItems.Item> item = item(cycleId, fileName, itemKey);
        if (item.isEmpty()) {
            return new MarkOutcome(CardChange.Outcome.NOT_FOUND, null, "No such acceptance item");
        }
        ChecklistSuggestion suggestion = new ChecklistSuggestion(cycleId, fileName, itemKey, mark, cleanEvidence, clock.instant());
        store.putSuggestion(suggestion);
        notifications.changed(null, cycleId, null, "checklist");
        return new MarkOutcome(CardChange.Outcome.OK, new ChecklistItem(itemKey, item.get().text(),
                store.mark(cycleId, fileName, itemKey).orElse(null), suggestion), null);
    }

    @Override
    public MarkOutcome acceptSuggestion(Actor actor, String cycleId, String fileName, String itemKey) {
        if (actor == Actor.CLAUDE) {
            return new MarkOutcome(CardChange.Outcome.REFUSED_FOR_CLAUDE, null, ClaudeRules.PROPOSE_ONLY);
        }
        Optional<ChecklistSuggestion> suggestion = store.suggestion(cycleId, fileName, itemKey);
        if (suggestion.isEmpty()) {
            return new MarkOutcome(CardChange.Outcome.NOT_FOUND, null, "No suggestion on this item");
        }
        // The user's mark, with Claude's evidence (mark() also drops the suggestion).
        return mark(actor, cycleId, fileName, itemKey, suggestion.get().mark(), suggestion.get().evidence());
    }

    @Override
    public MarkOutcome dismissSuggestion(Actor actor, String cycleId, String fileName, String itemKey) {
        if (actor == Actor.CLAUDE) {
            return new MarkOutcome(CardChange.Outcome.REFUSED_FOR_CLAUDE, null, ClaudeRules.PROPOSE_ONLY);
        }
        if (!store.deleteSuggestion(cycleId, fileName, itemKey)) {
            return new MarkOutcome(CardChange.Outcome.NOT_FOUND, null, "No suggestion on this item");
        }
        notifications.changed(null, cycleId, null, "checklist");
        Optional<AcceptanceItems.Item> item = item(cycleId, fileName, itemKey);
        return new MarkOutcome(CardChange.Outcome.OK, item.map(i -> new ChecklistItem(itemKey, i.text(),
                store.mark(cycleId, fileName, itemKey).orElse(null))).orElse(null), null);
    }

    private Optional<AcceptanceItems.Item> item(String cycleId, String fileName, String itemKey) {
        return store.spec(cycleId, fileName).flatMap(f -> AcceptanceItems.of(f.content()).stream()
                .filter(i -> i.key().equals(itemKey)).findFirst());
    }

    // --------------------------------------------------------------------------------------------- session log, test steps

    @Override
    public List<SessionLogEntry> log(String cycleId, int limit) {
        return store.log(cycleId, Math.max(1, Math.min(limit <= 0 ? 50 : limit, 500)));
    }

    @Override
    public SessionLogEntry append(Actor actor, String cycleId, String skill, String did, String found, String next) {
        if (blank(skill) || blank(did) || blank(found) || blank(next) || Stream.of(skill, did, found, next).anyMatch(s -> s.length() > SessionLogUseCase.MAX_TEXT)) {
            return null;
        }
        SessionLogEntry entry = new SessionLogEntry(0, cycleId, skill.strip(), did.strip(), found.strip(), next.strip(), clock.instant());
        long id = store.appendLog(entry);
        notifications.changed(null, cycleId, null, "log");
        return new SessionLogEntry(id, cycleId, entry.skill(), entry.did(), entry.found(), entry.next(), entry.at());
    }

    @Override
    public List<TestStep> steps(String cycleId) {
        Map<String, TestStep> marks = store.stepMarks(cycleId).stream().collect(Collectors.toMap(TestStep::key, Function.identity(), (a, b) -> a));
        return AcceptanceItems.of(brief(cycleId).text(), "test step").stream().map(i -> {
            TestStep m = marks.get(i.key());
            return m == null ? new TestStep(i.key(), i.text(), StepState.UNTESTED, 0, null, null, null)
                    : new TestStep(i.key(), i.text(), m.state(), m.calls(), m.cardNumber(), m.note(), m.at());
        }).toList();
    }

    @Override
    public StepOutcome mark(Actor actor, String cycleId, String stepKey, StepState state, int calls, Integer cardNumber, String note) {
        if (state == null) {
            return new StepOutcome(CardChange.Outcome.INVALID, null, "state is required: UNTESTED, SEEN or FAILED");
        }
        Optional<TestStep> step = steps(cycleId).stream().filter(s -> s.key().equals(stepKey)).findFirst();
        if (step.isEmpty()) {
            return new StepOutcome(CardChange.Outcome.NOT_FOUND, null, "No test step " + stepKey + " in the brief");
        }
        String cleanNote = note == null || note.isBlank() ? null : note.strip().length() > 1000 ? note.strip().substring(0, 1000) : note.strip();
        Instant now = clock.instant();
        store.putStepMark(cycleId, stepKey, state, Math.max(0, calls), cardNumber, cleanNote, now);
        notifications.changed(null, cycleId, null, "steps");
        return new StepOutcome(CardChange.Outcome.OK,
                new TestStep(stepKey, step.get().text(), state, Math.max(0, calls), cardNumber, cleanNote, now), null);
    }

    private static boolean blank(String s) {
        return s == null || s.isBlank();
    }

    // ---------------------------------------------------------------------------------------------------- cycle removed

    /** The cycle's pages, and what its snippets saved, go with it (specs/017). Optional: tests build this service without it. */
    private com.fathy.alfred.backend.board.application.port.out.SnippetStorePort snippets;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setSnippets(com.fathy.alfred.backend.board.application.port.out.SnippetStorePort snippets) {
        this.snippets = snippets;
    }

    /** The cycle's chat - messages, records, terminal items, settings, session - goes with it (specs/022). Optional like snippets. */
    private com.fathy.alfred.backend.board.application.port.out.ChatStorePort chats;

    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setChats(com.fathy.alfred.backend.board.application.port.out.ChatStorePort chats) {
        this.chats = chats;
    }

    @Override
    public void cycleRemoved(String cycleId) {
        store.cycleRemoved(cycleId);
        if (snippets != null) {
            snippets.cycleRemoved(cycleId);
        }
        if (chats != null) {
            chats.cycleRemoved(cycleId);
        }
        mentionedCalls.mentionedCallsChanged();
        notifications.changed(null, cycleId, null, "deleted");
    }

    private static boolean hasLiveCall(List<MentionRef> refs) {
        return refs.stream().anyMatch(r -> r.liveCallId() != null);
    }
}
