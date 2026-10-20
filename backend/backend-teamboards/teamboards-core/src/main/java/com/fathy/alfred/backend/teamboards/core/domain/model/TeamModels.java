package com.fathy.alfred.backend.teamboards.core.domain.model;

import com.fathy.alfred.backend.teamboards.spi.model.Attachment;
import com.fathy.alfred.backend.teamboards.spi.model.Capability;
import com.fathy.alfred.backend.teamboards.spi.model.Comment;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.Revision;
import com.fathy.alfred.backend.teamboards.spi.model.Scope;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The Team slice's records (specs/027, 028 data-model.md). Neutral terms only - each connector maps its provider's words
 * onto them. Work items are read live; only a board's main item and items linked to cards keep a saved copy.
 */
public final class TeamModels {

    private TeamModels() {
    }

    /** Who asked: the person at the page, or Claude through the MCP (X-Alfred-Actor: claude). */
    public enum Who {
        USER, CLAUDE;

        public static Who of(String actor) {
            return "claude".equalsIgnoreCase(actor == null ? "" : actor.strip()) ? CLAUDE : USER;
        }
    }

    /** An installed connector (or a known one that is not installed) and what it can do. */
    public record ConnectorInfo(String kind, String displayName, boolean installed, Set<Capability> capabilities, Map<String, String> words) {
    }

    /** One configured provider account. {@code listsAt}: when the filter lists were last read. */
    public record ConnectionRow(String id, String kind, String name, String baseUrl, Scope scope, Instant listsAt, Instant createdAt,
                                Set<Capability> capabilities) {
    }

    /** A member of the provider's organisation (a person pill). {@code email}: the unique name. */
    public record PersonRow(String extId, String name, String email) {
    }

    /** Whether a token is live for a connection (never the token itself). */
    public record TokenStatus(boolean live, PersonRow owner, Instant expiresAt) {
    }

    /** Who "me" is: the token's owner, or the person someone marked "This is me" (until the token changes). */
    public record Me(PersonRow person, String source) {
    }

    public record SquadRow(String conn, String extId, String name, String project, String alfredProject, String alfredTeam, List<PersonRow> members) {
    }

    public record BoardRow(String extId, String name, String project, String team, List<String> columns) {
    }

    public record SprintRow(String extId, String name, String team, Instant starts, Instant ends) {
    }

    /** A work item type's state with its category (Proposed, InProgress, Resolved, Completed, Removed). */
    public record StateRow(String project, String type, String name, String category) {
    }

    /** The filter lists the Team tab and Mine need: the only Team data kept besides saved copies (FR-013). */
    public record Lists(List<String> types, List<StateRow> states, List<String> areas, List<SquadRow> teams, List<SprintRow> iterations,
                        List<PersonRow> people, List<BoardRow> boards, Instant at, List<String> tags) {
    }

    public enum MappingKind { SPRINT, SQUAD, AREA, PROJECT }

    /** Items of {@code kind} = {@code extValue} open their boards in {@code alfredProject} (on {@code alfredBoard} when set). */
    public record MappingRow(long id, String conn, MappingKind kind, String extValue, String alfredProject, String alfredBoard) {
    }

    public enum SeedTarget { PURPOSE, STEPS, ACCEPTANCE, CONTEXT }

    public record FieldMapRow(String conn, String itemType, String field, SeedTarget target) {
    }

    /** A card kind an Azure type becomes (BUG, TASK, NOTE, QUESTION) or NONE (stays in Related items). */
    public record TypeKindRow(String conn, String type, String kind) {
    }

    // ------------------------------------------------------------------------------------------------ search, items

    /** Where a search result already sits on Alfred: a board, its role there, and whether Azure moved past the copy. */
    public record BoardBadge(String boardId, String name, String role, Integer copyRev, boolean changed) {
        public BoardBadge with(String n, boolean ch) {
            return new BoardBadge(boardId, n, role, copyRev, ch);
        }
    }

    /** One live search row (never stored); {@code parent}: its parent's id when the tracker gave one. */
    public record SearchRow(String id, String type, String title, String state, String stateCategory, PersonRow assigned, String iteration,
                            String area, Instant changedAt, int rev, String url, List<BoardBadge> boards, List<String> cards, String parent) {
    }

    /**
     * A page of matches. With show PARENTS or TREE, {@code context} holds the parents (and children) that did not match,
     * read live for this page only; {@code contextLeftOut} counts those past the cap.
     */
    public record SearchResult(List<SearchRow> items, int total, boolean fullText, int page, int pageSize, String show, List<SearchRow> context,
                               int contextLeftOut) {
        public SearchResult(List<SearchRow> items, int total, boolean fullText, int page, int pageSize) {
            this(items, total, fullText, page, pageSize, "ITEMS", List.of(), 0);
        }
    }

    /** A field that differs between the saved copy and Azure now. */
    public record FieldDiff(String field, String from, String to) {
    }

    /**
     * One item read live (never stored), with what Alfred keeps of it: the saved copy's rev and the diff against it,
     * the boards it sits on and the cards linking it. {@code item.nativeJson} is left out of a view.
     */
    public record ItemView(Item item, String stateCategory, List<Comment> comments, List<Revision> history, List<Attachment> attachments,
                           Integer copyRev, Instant copySavedAt, List<FieldDiff> diff, List<BoardBadge> boards, List<CardLinkRow> cards) {
    }

    // ------------------------------------------------------------------------------------------- boards and copies

    public static final String MAIN = "MAIN";
    public static final String CARD = "CARD";
    public static final String REF = "REF";

    /**
     * An Azure item on an Alfred board (028 R5): MAIN (one per board with items), CARD (linked to a card) or REF (in the
     * main's tree, or added by hand). {@code relation}: ANCESTOR, DESCENDANT, LINK, ADDED, ROOT.
     */
    public record BoardItemRow(String boardId, String conn, String item, String role, String relation, String linkKind, String parent, int depth,
                               String type, String title, String state, String stateCategory, int rev, Instant leftTreeAt, Instant addedAt,
                               String addedBy) {
        public BoardItemRow withRole(String r) {
            return new BoardItemRow(boardId, conn, item, r, relation, linkKind, parent, depth, type, title, state, stateCategory, rev, leftTreeAt,
                    addedAt, addedBy);
        }
    }

    /** The whole item as Azure had it when last kept (fields, relations, comments). */
    public record ItemCopyRow(String conn, String item, int rev, String itemJson, String commentsJson, Instant savedAt) {
    }

    /** One sync of a saved item: what changed from the copy; {@code kept} once the user kept Azure's version. */
    public record SyncRow(long id, String conn, String item, int fromRev, int toRev, Instant at, List<FieldDiff> diff, boolean kept) {
    }

    /** A board's Related items: its main, then every item with its role. */
    public record BoardItems(String boardId, BoardItemRow main, List<BoardItemRow> items, Instant syncedAt) {
    }

    /** A card linked to an Azure item, and which Azure markers Alfred wrote. */
    public record CardLinkRow(String cardId, String boardId, String conn, String item, Instant linkedAt, String linkedBy, boolean hyperlink,
                              boolean tag, String commentId) {
    }

    /** A card's Azure item for the card strip: the copy's summary, Azure's state, and whether it changed since the copy. */
    public record CardItem(String conn, String item, String type, String title, String state, String stateCategory, String changedBy,
                           Instant changedAt, int copyRev, boolean changed, boolean closedInAzure, List<Comment> comments, String url) {
    }

    // ------------------------------------------------------------------------------------------------ incoming, rules

    public enum IncomingSource { TREE, RULE, HOOK, HAND, MCP }

    public enum IncomingState { WAITING, CARDED, LINKED, IGNORED }

    /** An Azure item waiting on a board for New card / Link to card / Ignore (028 US3). */
    public record IncomingRow(String boardId, String conn, String item, IncomingSource source, Instant arrivedAt, int rev, String type, String title,
                              String matchCard, Integer matchScore, String proposalAction, String proposalCard, String proposalReason,
                              IncomingState state, Integer ignoredRev) {
    }

    // ------------------------------------------------------------------------------------------------------ matches

    public enum MatchState { PROPOSED, LINKED, REJECTED }

    /**
     * A tracker item that may be what an unlinked card is about (specs/030 D5), found by code - shared words and endpoint
     * paths, no model. {@code why}: the code's reason, or Claude's once it judged it. REJECTED is kept so it is never
     * proposed again for that card.
     */
    public record MatchRow(String boardId, String cardId, String conn, String item, MatchState state, String why, double score, Instant at) {
    }

    /** A board's watch rule: a saved search body, run on board open, Refresh, hook ping and the MCP. */
    /** A saved search of one connection (specs/029); {@code position}: its place among the pills. */
    /** A named field set for new items of a type (specs/038 FR-11): {@code fieldsJson} a JSON object of reference name -> value. */
    public record TemplateRow(String conn, String name, String type, String fieldsJson, Instant updatedAt) {
    }

    public record SavedSearchRow(long id, String conn, String name, String queryJson, int position, Integer lastCount, Instant updatedAt) {
    }

    public record WatchRuleRow(long id, String boardId, String conn, String name, String queryJson, Instant createdAt, Instant lastRunAt,
                               String lastSource, int lastNew) {
    }

    // ---------------------------------------------------------------------------------------------- Azure writes

    public enum WriteState { WAITING, SENDING, DONE, PARTIAL, REJECTED }

    /** FIELD (specs/030): one field set by its reference name ({@code field}) to {@code value} - empty clears it. */
    public enum StepKind { STATE, COMMENT, ATTACH, HYPERLINK, UNHYPERLINK, TAG, UNTAG, CREATE, LINK_ALFRED, FIELD }

    public record StepResult(boolean ok, String message, String azureId) {
    }

    /** One write in a bundle: what, with what, whether it is ticked, and how it went. */
    public record WriteStep(StepKind kind, Map<String, String> payload, boolean ticked, boolean unmasked, StepResult result) {
        public WriteStep {
            payload = payload == null ? Map.of() : Map.copyOf(payload);
        }
    }

    /**
     * A consent bundle (028 R9): every write to Azure Alfred makes for Claude, and the user's own actions as an audit.
     * {@code note} (specs/034): the user's reason when they rejected it, for Claude to read; null otherwise. Step payloads
     * may also carry {@code from} (the item's value when the step was made), {@code draft} (Claude's first comment text)
     * and {@code previous} (the text before Claude's last redraft) - free keys, so older Alfreds still read the bundle.
     */
    public record WriteBundle(long id, String boardId, String cardId, String conn, String item, String origin, String askedIn, String title,
                              List<WriteStep> steps, WriteState state, Instant createdAt, Instant decidedAt, String decidedBy, String note) {
        public WriteBundle {
            steps = steps == null ? List.of() : List.copyOf(steps);
        }

        public WriteBundle(long id, String boardId, String cardId, String conn, String item, String origin, String askedIn, String title,
                           List<WriteStep> steps, WriteState state, Instant createdAt, Instant decidedAt, String decidedBy) {
            this(id, boardId, cardId, conn, item, origin, askedIn, title, steps, state, createdAt, decidedAt, decidedBy, null);
        }
    }

    /**
     * What a waiting bundle meets in the tracker now (specs/034): the item's state and who changed it last, the footer its
     * comments end with, and per state/field step the value now, the states Azure allows from it (null: not known) and
     * whether the item changed since the step was made.
     */
    public record BundleCheck(long id, String itemState, String changedBy, Instant changedAt, String footer, List<StepCheck> steps) {
        public BundleCheck {
            steps = steps == null ? List.of() : List.copyOf(steps);
        }
    }

    public record StepCheck(int step, String now, List<String> allowed, boolean changed, boolean refused) {
    }

    // ------------------------------------------------------------------------------------------------------ hook

    public record HookInfo(String conn, String path, Instant lastPingAt, String lastEvent, int badPings, List<String> waiting, String publicAddress,
                           boolean secretSet) {
    }
}
