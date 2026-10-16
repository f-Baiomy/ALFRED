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
import com.fathy.alfred.backend.board.domain.model.CardRef;
import com.fathy.alfred.backend.board.domain.model.SessionLogEntry;
import com.fathy.alfred.backend.board.domain.model.StepState;
import com.fathy.alfred.backend.board.domain.model.TestStep;
import com.fathy.alfred.backend.board.domain.model.NextSteps;
import com.fathy.alfred.backend.board.domain.model.WaitingOn;
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

    /** One history entry by id. */
    Optional<ActivityEntry> activityEntry(long id);

    /** A comment's text after its author edited it (the earlier text is kept with {@link #saveVersion}). */
    void updateActivityText(long id, String text);

    /** Removes one history entry - a reaction taken back. */
    void deleteActivity(long id);

    /** Keeps an earlier text of a comment or description (edit with a history). */
    void saveVersion(com.fathy.alfred.backend.board.domain.model.TextVersion version);

    /** Gives the pictures a text shows, not yet owned, to this card (or cycle) - so they go when it goes. */
    void attachImages(java.util.Collection<String> ids, String cardId, String cycleId);

    /** The earlier texts of {@code comment:<id>} or {@code description:<card id>}, newest first. */
    List<com.fathy.alfred.backend.board.domain.model.TextVersion> versions(String owner);

    /** Entries newer than {@code afterId}. */
    List<ActivityEntry> after(String cardId, long afterId);

    /** Each card's newest comment. */
    Map<String, ActivityEntry> lastComments(Collection<String> cardIds);

    /** History entries of every card after {@code afterId}, oldest first, with their card; project/cycleId/actor narrow it when set. */
    /** The newest history entry written before {@code at} (0 when none) - where a chat digest starts (specs/022 FR-023). */
    long activityIdBefore(java.time.Instant at);

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

    /**
     * For each signature, the project's cards that are not closed with it, most recently updated first (a few per
     * signature - enough to find one other than the card asked about). Descriptions are not loaded.
     */
    Map<String, List<Card>> openBySignature(String project, Collection<String> signatures);

    List<ClosedReason> closedReasons(String project, int limit);

    /** Cards (any status) with this signature or a title containing one of {@code words}; every board when project is null. */
    List<Card> similar(String project, String signature, List<String> words, int limit);

    // waiting on

    Optional<WaitingOn> waiting(String cardId);

    Map<String, WaitingOn> waitings(Collection<String> cardIds);

    void setWaiting(String cardId, WaitingOn waiting);

    /** What waits on whom on one board (a project's, or a cycle's when cycleId is set). */
    NextSteps nextSteps(String project, String cycleId);

    // blocked by, spec items, merge (specs/015 phase 3-4)

    void addBlock(String cardId, String blockedById);

    boolean removeBlock(String cardId, String blockedById);

    /** For each card, the cards blocking it. */
    Map<String, List<CardRef>> blockersOf(Collection<String> cardIds);

    void addSpecItem(String cardId, String cycleId, String fileName, String itemKey);

    boolean removeSpecItem(String cardId, String cycleId, String fileName, String itemKey);

    /** [cycleId, fileName, itemKey] rows of one card. */
    List<String[]> specItemsOf(String cardId);

    /** For one cycle's spec items ("file\nkey"), the cards about them. */
    Map<String, List<CardRef>> cardsBySpecItem(String cycleId);

    /** Moves the source card's history, mentions, links, spec items and blocks onto the target. */
    void mergeInto(String sourceId, String targetId);

    // session log, test steps

    long appendLog(SessionLogEntry entry);

    /** Newest first. */
    List<SessionLogEntry> log(String cycleId, int limit);

    List<TestStep> stepMarks(String cycleId);

    void putStepMark(String cycleId, String stepKey, StepState state, int calls, Integer cardNumber, String note, java.time.Instant at);

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

    /** Swaps the brief with the version it replaced (so a second restore undoes the first). False when there is none. */
    boolean restoreBrief(String cycleId, java.time.Instant at);

    /** Swaps a spec file with the version it replaced. False when there is none. */
    boolean restoreSpec(String cycleId, String name, java.time.Instant at);

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

    /** The cards a cycle holds (to delete them with the cycle), at most 10000. */
    List<String> cardIdsOfCycle(String cycleId);

    /** board.db's size on disk, what its data uses, the free space deleted rows left, and counts. */
    com.fathy.alfred.backend.board.domain.model.BoardStorage storage();

    /** Rewrites board.db without its free space (VACUUM). */
    void compact();

    // ------------------------------------------------------------------------------------------- re-test (specs/016)

    java.util.Optional<com.fathy.alfred.backend.board.domain.model.RetestPlan> retestPlan(String cardId);

    void putRetestPlan(com.fathy.alfred.backend.board.domain.model.RetestPlan plan);

    long appendRetestRun(com.fathy.alfred.backend.board.domain.model.RetestRun run);

    /** A card's recorded re-tests, newest first. */
    List<com.fathy.alfred.backend.board.domain.model.RetestRun> retestRuns(String cardId, int limit);

    void putAppStart(String project, java.time.Instant at);

    java.util.Optional<java.time.Instant> appStart(String project);

    /** The project's app starts Alfred saw, oldest first (the last ones kept) - which build a call ran on (specs/020). */
    default List<java.time.Instant> appStarts(String project) {
        return appStart(project).map(List::of).orElse(List.of());
    }

    // ------------------------------------------------------------------------------------------------------- teams

    /** Every team, in the user's order. */
    List<com.fathy.alfred.backend.board.domain.model.Team> teams();

    /** Adds the team, or replaces the one with its id. */
    void putTeam(com.fathy.alfred.backend.board.domain.model.Team team);

    /** Deletes the team and takes it off every card it was on. */
    void deleteTeam(String id);

    // ------------------------------------------------------------------------------------------------- questions (019)

    /** Indexes the questions of one question comment (replacing what that comment had). */
    void putQuestions(long entryId, java.util.List<com.fathy.alfred.backend.board.domain.model.Question> questions);

    /** Every question of a card, oldest comment first, then in order. */
    java.util.List<com.fathy.alfred.backend.board.domain.model.Question> questionsOf(String cardId);

    void updateQuestion(com.fathy.alfred.backend.board.domain.model.Question question);

    /** Open questions per card (OPEN, or LATER whose time has come). */
    java.util.Map<String, Integer> openQuestionCounts(java.util.Collection<String> cardIds, java.time.Instant now);

    /** Per card, the option Claude recommends in its first open question that has one (specs/020). */
    default java.util.Map<String, String> openQuestionAdvice(java.util.Collection<String> cardIds, java.time.Instant now) {
        return java.util.Map.of();
    }

    /** The same advice with its triage facts (confidence, checked, severity, group) - {@link #openQuestionAdvice} when a store has none. */
    default java.util.Map<String, com.fathy.alfred.backend.board.domain.model.Advice> openQuestionAdviceDetail(java.util.Collection<String> cardIds,
                                                                                                             java.time.Instant now) {
        java.util.Map<String, com.fathy.alfred.backend.board.domain.model.Advice> out = new java.util.HashMap<>();
        openQuestionAdvice(cardIds, now).forEach((id, option) -> out.put(id, com.fathy.alfred.backend.board.domain.model.Advice.of(option)));
        return out;
    }

    /**
     * Short names (specs/021): the few words a mention reads. {@code kind} "card" is keyed by card id, "item" by
     * {@code cycleId/fileName/itemKey}. A blank name removes it.
     */
    default java.util.Map<String, String> shortNames(String kind, java.util.Collection<String> owners) {
        return java.util.Map.of();
    }

    default void putShortName(String kind, String owner, String shortName) {
    }

    /** Open questions per card of a project (and cycle, when given) - the nav's count and the questions list. */
    java.util.Map<String, Integer> openQuestionCards(String project, String cycleId, java.time.Instant now);

    /** Claude's question comments with no index yet: written before specs/019, or imported. */
    java.util.List<ActivityEntry> unindexedQuestions();
}
