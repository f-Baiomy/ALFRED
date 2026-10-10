package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.CycleRemovedUseCase;
import com.fathy.alfred.backend.board.application.port.in.ManageBriefUseCase;
import com.fathy.alfred.backend.board.application.port.in.ManageSpecFilesUseCase;
import com.fathy.alfred.backend.board.application.port.in.MarkChecklistUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.application.port.out.MentionedCallsChangedPort;
import com.fathy.alfred.backend.board.domain.AcceptanceItems;
import com.fathy.alfred.backend.board.domain.ClaudeRules;
import com.fathy.alfred.backend.board.domain.MentionParser;
import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.ActivityKind;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.ChecklistFile;
import com.fathy.alfred.backend.board.domain.model.ChecklistItem;
import com.fathy.alfred.backend.board.domain.model.ChecklistMark;
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

/**
 * What a session cycle is for: its brief, its spec files and the acceptance checklist marked on them (specs/014 US5,
 * US9). Claude reads these; only the user writes them.
 */
@Service
public class CycleBriefService implements ManageBriefUseCase, ManageSpecFilesUseCase, MarkChecklistUseCase, CycleRemovedUseCase {

    static final int MAX_NAME = 200;

    private final BoardStorePort store;
    private final BoardNotificationPort notifications;
    private final MentionedCallsChangedPort mentionedCalls;
    private final Clock clock;

    @Autowired
    public CycleBriefService(BoardStorePort store, BoardNotificationPort notifications, MentionedCallsChangedPort mentionedCalls) {
        this(store, notifications, mentionedCalls, Clock.systemUTC());
    }

    CycleBriefService(BoardStorePort store, BoardNotificationPort notifications, MentionedCallsChangedPort mentionedCalls, Clock clock) {
        this.store = store;
        this.notifications = notifications;
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
        if (actor == Actor.CLAUDE) {
            return new BriefOutcome(CardChange.Outcome.REFUSED_FOR_CLAUDE, null, ClaudeRules.USER_ONLY);
        }
        String clean = text == null ? "" : text;
        if (clean.length() > ManageBriefUseCase.MAX_TEXT) {
            return new BriefOutcome(CardChange.Outcome.INVALID, null, "The brief is larger than 256 KB");
        }
        List<MentionRef> before = store.mentionsOf(MentionOwner.BRIEF, cycleId).stream().map(m -> m.ref()).toList();
        CycleBrief brief = new CycleBrief(cycleId, clean, clock.instant());
        store.putBrief(brief);
        List<MentionRef> after = MentionParser.mentions(clean);
        store.replaceMentions(MentionOwner.BRIEF, cycleId, null, after);
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
        if (actor == Actor.CLAUDE) {
            return new SpecOutcome(CardChange.Outcome.REFUSED_FOR_CLAUDE, null, false, ClaudeRules.USER_ONLY);
        }
        String problem = checkName(name);
        if (problem != null) {
            return new SpecOutcome(CardChange.Outcome.INVALID, null, false, problem);
        }
        String text = content == null ? "" : content;
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
        SpecFile file = new SpecFile(cycleId, name, text, size, now);
        boolean replaced = store.putSpec(file);
        if (replaced) {
            for (String cardId : store.cardsMentioningSpec(cycleId, name)) {
                store.append(new ActivityEntry(0, cardId, actor, ActivityKind.SPEC_REPLACED, null, null, name, now));
            }
        }
        notifications.changed(null, cycleId, null, "specs");
        return new SpecOutcome(CardChange.Outcome.OK, file.info(), replaced, null);
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
        List<ChecklistFile> out = new ArrayList<>();
        for (SpecFileInfo info : store.specs(cycleId)) {
            Optional<SpecFile> file = store.spec(cycleId, info.name());
            if (file.isEmpty()) {
                continue;
            }
            List<ChecklistItem> items = AcceptanceItems.of(file.get().content()).stream()
                    .map(i -> new ChecklistItem(i.key(), i.text(), marks.get(info.name() + "\n" + i.key()))).toList();
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

    // ---------------------------------------------------------------------------------------------------- cycle removed

    @Override
    public void cycleRemoved(String cycleId) {
        store.cycleRemoved(cycleId);
        mentionedCalls.mentionedCallsChanged();
        notifications.changed(null, cycleId, null, "deleted");
    }

    private static boolean hasLiveCall(List<MentionRef> refs) {
        return refs.stream().anyMatch(r -> r.liveCallId() != null);
    }
}
