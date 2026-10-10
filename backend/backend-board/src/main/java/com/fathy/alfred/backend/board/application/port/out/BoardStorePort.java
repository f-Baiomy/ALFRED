package com.fathy.alfred.backend.board.application.port.out;

import com.fathy.alfred.backend.board.domain.model.ActivityEntry;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.BoardChanges;
import com.fathy.alfred.backend.board.domain.model.CallBadge;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CardQuery;
import com.fathy.alfred.backend.board.domain.model.CardsPage;
import com.fathy.alfred.backend.board.domain.model.ChecklistMark;
import com.fathy.alfred.backend.board.domain.model.ChecklistSuggestion;
import com.fathy.alfred.backend.board.domain.model.ClosedReason;
import com.fathy.alfred.backend.board.domain.model.CycleBrief;
import com.fathy.alfred.backend.board.domain.model.Mention;
import com.fathy.alfred.backend.board.domain.model.MentionOwner;
import com.fathy.alfred.backend.board.domain.model.MentionRef;
import com.fathy.alfred.backend.board.domain.model.Proposal;
import com.fathy.alfred.backend.board.domain.model.SimilarClosed;
import com.fathy.alfred.backend.board.domain.model.SpecFile;
import com.fathy.alfred.backend.board.domain.model.SpecFileInfo;

import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/** board.db. Lists never select descriptions or history; every list has a LIMIT (constitution II). */
public interface BoardStorePort {

    // cards

    /** The next free number of a project: one above the highest ever given, so a deleted card's number is never reused. */
    int nextNumber(String project);

    void insert(Card card);

    void update(Card card);

    Optional<Card> find(String id);

    Optional<Card> findByNumber(String project, int number);

    /** Deletes the card; its activity and mentions go with it. */
    boolean delete(String id);

    /** One page of rows matching the query (summary columns only) and the total. */
    List<Card> query(CardQuery query);

    int count(CardQuery query);

    CardsPage.Progress progress(String project, String cycleId);

    // activity

    long append(ActivityEntry entry);

    List<ActivityEntry> activity(String cardId, int offset, int limit);

    int activityCount(String cardId);

    Map<String, Integer> commentCounts(Collection<String> cardIds);

    /** The newest entry of a kind on a card, if any. */
    Optional<ActivityEntry> lastOf(String cardId, String kind);

    /** Entries newer than {@code afterId}. */
    List<ActivityEntry> after(String cardId, long afterId);

    /** Each card's newest comment. */
    Map<String, ActivityEntry> lastComments(Collection<String> cardIds);

    /** History entries of every card after {@code afterId}, oldest first, with their card; project/cycleId/actor narrow it when set. */
    List<BoardChanges.Entry> activityAfter(long afterId, String project, String cycleId, Actor actor, int limit);

    /** The id of the newest history entry (0 when none). */
    long lastActivityId();

    /** The id of {@code actor}'s newest history entry, on {@code project}'s board or anywhere when null (0 when none). */
    long lastActivityIdBy(Actor actor, String project);

    /** Briefs, spec files, checklist marks and suggestions written after {@code afterMillis}, oldest first. */
    List<BoardChanges.CycleChange> cycleChangesAfter(long afterMillis, String project, String cycleId, int limit);

    /** The newest time a brief, spec file, mark or suggestion was written (0 when none). */
    long lastCycleChangeMillis();

    // mentions

    /** Replaces everything one owner mentions with {@code refs}. */
    void replaceMentions(MentionOwner owner, String ownerId, String cardId, List<MentionRef> refs);

    void addDirect(String cardId, MentionRef ref);

    boolean removeDirect(String cardId, String type, String ref);

    /** A card's mentions (every owner) plus its direct links, first occurrence kept. */
    List<MentionRef> linksOf(String cardId);

    /** The first {@code perCard} mentions of each card, for the board's chips. */
    Map<String, List<MentionRef>> chipsOf(Collection<String> cardIds, int perCard);

    /** Live call ids mentioned anywhere (cards, comments, briefs, checklist evidence). */
    Set<String> mentionedLiveCallIds();

    /** Ids of cards whose own text, comments or links mention the spec file {@code cycleId/name}. */
    List<String> cardsMentioningSpec(String cycleId, String name);

    /** Cards shown on calls of a cycle: mentions with that cycle, or on that cycle's cards. */
    Map<String, List<CallBadge>> badgesOfCycle(String cycleId);

    Map<String, List<CallBadge>> badgesOfCalls(Collection<String> callIds);

    // similarity and Claude's context

    /** For each signature, the newest CLOSED card of the project with it. */
    Map<String, SimilarClosed> closedBySignature(String project, Collection<String> signatures);

    List<ClosedReason> closedReasons(String project, int limit);

    /** Cards (any status) with this signature or a title containing one of {@code words}; every board when project is null. */
    List<Card> similar(String project, String signature, List<String> words, int limit);

    // proposals

    Optional<Proposal> proposal(String cardId);

    Map<String, Proposal> proposals(Collection<String> cardIds);

    /** Replaces the card's open proposal. */
    void putProposal(Proposal proposal);

    boolean deleteProposal(String cardId);

    // cycle brief, spec files, checklist

    Optional<CycleBrief> brief(String cycleId);

    void putBrief(CycleBrief brief);

    List<SpecFileInfo> specs(String cycleId);

    Optional<SpecFile> spec(String cycleId, String name);

    /** True when it replaced a file of the same name. */
    boolean putSpec(SpecFile file);

    boolean deleteSpec(String cycleId, String name);

    List<ChecklistMark> marks(String cycleId);

    Optional<ChecklistMark> mark(String cycleId, String fileName, String itemKey);

    void putMark(ChecklistMark mark);

    List<ChecklistSuggestion> suggestions(String cycleId);

    Optional<ChecklistSuggestion> suggestion(String cycleId, String fileName, String itemKey);

    void putSuggestion(ChecklistSuggestion suggestion);

    boolean deleteSuggestion(String cycleId, String fileName, String itemKey);

    /** Removes a cycle's brief, spec files, checklist marks and suggestions and the mentions written there; flags its cards. */
    void cycleRemoved(String cycleId);

    /** The indexed mentions of one owner (for tests and import). */
    List<Mention> mentionsOf(MentionOwner owner, String ownerId);
}
