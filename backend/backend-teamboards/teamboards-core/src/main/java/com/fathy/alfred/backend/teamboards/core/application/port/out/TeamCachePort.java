package com.fathy.alfred.backend.teamboards.core.application.port.out;

import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardBadge;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardItemRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.CardLinkRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.FieldDiff;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.FieldMapRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.IncomingRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.IncomingState;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemCopyRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MappingKind;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MappingRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.PersonRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SprintRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SquadRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.StateRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SyncRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.TypeKindRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WatchRuleRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WriteBundle;
import com.fathy.alfred.backend.teamboards.spi.model.Scope;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * teamboards.db (specs/028 data-model.md). Never a token, and never a search result: connections, the filter lists, the
 * Start rows, and what boards keep of Azure - board items (copies only for the main and card-linked items), syncs, card
 * links, Incoming, watch rules, consent bundles and the hook.
 */
public interface TeamCachePort {

    // ---------------------------------------------------------------------------------------------------- connections

    record StoredConnection(String id, String kind, String name, String baseUrl, Scope scope, Instant listsAt, Instant createdAt) {
    }

    List<StoredConnection> connections();

    Optional<StoredConnection> connection(String id);

    void putConnection(StoredConnection c);

    boolean deleteConnection(String id);

    void rescope(String id, String name, Scope scope);

    void markLists(String id, Instant at);

    /** The one-time "the old cache was deleted" notice of the 028 upgrade: true until dismissed. */
    boolean upgradeNotice();

    void dismissUpgradeNotice();

    // --------------------------------------------------------------------------------------------------- filter lists

    /** People are merged, never dropped: a mention or an owner keeps a name even after the person left a team. */
    void upsertPeople(String conn, List<PersonRow> people);

    List<PersonRow> people(String conn);

    Optional<PersonRow> person(String conn, String extId);

    /** People ids the store has no name for (team members not resolved yet). */
    List<String> unknownPeople(String conn, Collection<String> ids);

    record SquadIn(String extId, String name, String project, List<String> memberIds) {
    }

    void replaceSquads(String conn, List<SquadIn> squads);

    List<SquadRow> squads(String conn);

    boolean mapSquad(String conn, String extId, String alfredProject, String alfredTeam);

    void replaceBoards(String conn, List<BoardRow> boards);

    List<BoardRow> boards(String conn);

    void replaceSprints(String conn, List<SprintRow> sprints);

    List<SprintRow> sprints(String conn);

    void replaceStates(String conn, List<StateRow> states);

    List<StateRow> states(String conn);

    void replaceAreas(String conn, List<String> areas);

    List<String> areas(String conn);

    // ------------------------------------------------------------------------------------- mappings, maps, kinds

    List<MappingRow> mappings(String conn);

    MappingRow putMapping(String conn, MappingKind kind, String extValue, String alfredProject, String alfredBoard);

    boolean deleteMapping(String conn, long id);

    List<FieldMapRow> fieldMaps(String conn);

    void putFieldMap(FieldMapRow row);

    boolean deleteFieldMap(String conn, String itemType, String field);

    List<TypeKindRow> typeKinds(String conn);

    void putTypeKind(TypeKindRow row);

    // ------------------------------------------------------------------------------------------------ board items

    List<BoardItemRow> boardItems(String boardId);

    Optional<BoardItemRow> boardItem(String boardId, String conn, String item);

    Optional<BoardItemRow> main(String boardId);

    /** Every board an item sits on. */
    List<BoardItemRow> boardsOfItem(String conn, String item);

    /** The board badges of many items at once, for a search page. */
    Map<String, List<BoardBadge>> badges(String conn, Collection<String> items);

    void putBoardItem(BoardItemRow row);

    /** Sets a board's main: the old main (if another) becomes {@code oldRole}. One main per board, by a unique index. */
    void setMain(String boardId, String conn, String item, String oldRole);

    void setRole(String boardId, String conn, String item, String role);

    boolean deleteBoardItem(String boardId, String conn, String item);

    /** Drops a board's tree references (REF rows with relation ANCESTOR/DESCENDANT/LINK) - before a re-root. */
    int deleteTreeRefs(String boardId);

    /** A tree reference the user removed from a board: a later sync does not bring it back (028 review). */
    void markRemoved(String boardId, String conn, String item, Instant at);

    boolean removed(String boardId, String conn, String item);

    /** Forgets one removal (the user added the item again), or all of a board's ({@code item} null). */
    void clearRemoved(String boardId, String conn, String item);

    void markLeftTree(String boardId, String conn, String item, Instant at);

    /** A board is gone: its items, card links, incoming and watch rules go. The (conn, item) pairs it held. */
    List<String[]> deleteBoard(String boardId);

    /** Board ids that have any Azure item. */
    List<String> boardsWithItems();

    // ----------------------------------------------------------------------------------------- copies and syncs

    Optional<ItemCopyRow> copy(String conn, String item);

    void putCopy(ItemCopyRow row);

    /** Removes the copy when no board main and no card link needs it any more. True when removed. */
    boolean dropCopyIfUnused(String conn, String item);

    long addSync(String conn, String item, int fromRev, int toRev, Instant at, List<FieldDiff> diff);

    List<SyncRow> syncs(String conn, String item, int limit);

    void markSyncsKept(String conn, String item);

    // -------------------------------------------------------------------------------------------------- card links

    List<CardLinkRow> cardLinks(String cardId);

    List<CardLinkRow> cardLinksOfItem(String conn, String item);

    List<CardLinkRow> cardLinksOfBoard(String boardId);

    /** False when the card already links the item. */
    boolean insertCardLink(CardLinkRow row);

    void putCardLink(CardLinkRow row);

    boolean deleteCardLink(String cardId, String conn, String item);

    // ---------------------------------------------------------------------------------------------------- incoming

    List<IncomingRow> incoming(String boardId, IncomingState state);

    Optional<IncomingRow> incomingRow(String boardId, String conn, String item);

    /**
     * An arrival: a new WAITING row, or an IGNORED one reopened when {@code rev} is newer than the rev it was ignored at.
     * False when it is already there (waiting, carded, linked, or ignored and unchanged).
     */
    boolean arrive(IncomingRow row);

    void putIncoming(IncomingRow row);

    // ------------------------------------------------------------------------------------------------- watch rules

    List<WatchRuleRow> rules(String boardId);

    Optional<WatchRuleRow> rule(long id);

    WatchRuleRow putRule(WatchRuleRow row);

    boolean deleteRule(long id);

    void markRuleRun(long id, Instant at, String source, int found);

    /** Every rule of a connection, for a hook ping. */
    List<WatchRuleRow> rulesOfConnection(String conn);

    // ---------------------------------------------------------------------------------------------- write bundles

    long insertBundle(WriteBundle b);

    Optional<WriteBundle> bundle(long id);

    List<WriteBundle> bundles(String boardId, String cardId, String state, int limit);

    void updateBundle(WriteBundle b);

    void putBundleFile(long bundleId, int step, String name, byte[] data);

    Optional<byte[]> bundleFile(long bundleId, int step);

    void deleteBundleFiles(long bundleId);

    /** One step's built file goes (its step changed after it was built). */
    void deleteBundleFile(long bundleId, int step);

    /** WAITING -> SENDING as one compare-and-swap: false when another approve got there first. */
    boolean claimSending(long bundleId, java.time.Instant at, String by);

    // ------------------------------------------------------------------------------------------------------- hook

    record HookRow(String conn, String secretHash, Instant rotatedAt, Instant lastPingAt, String lastEvent, int badPings, String publicAddress) {
    }

    Optional<HookRow> hook(String conn);

    void putHookSecret(String conn, String secretHash, Instant at);

    void recordPing(String conn, Instant at, String event);

    void recordBadPing(String conn);

    void putPublicAddress(String conn, String address);

    void addWaiting(String conn, Collection<String> items, String event, Instant at);

    List<String> waiting(String conn);

    /** The waiting ids, removed as they are read. */
    List<String> takeWaiting(String conn);

    // ------------------------------------------------------------------------------------------------------- me

    record MeOverride(String conn, String person, String tokenOwner, Instant at) {
    }

    Optional<MeOverride> meOverride(String conn);

    void putMeOverride(MeOverride o);

    void clearMeOverride(String conn);

    // ---------------------------------------------------------------------------------------- starts and pending

    /** A start the user asked for: where it goes ("project|boardId", board empty = the project's chat) and its state. */
    record StartRow(String conn, String extId, String target, Long chatMessageId, String state, Instant at) {
    }

    Optional<StartRow> start(String conn, String extId);

    void putStart(StartRow row);

    /** Claims an item's start: false when a start row is there already (one start per item, even for two clicks at once). */
    boolean claimStart(StartRow row);

    boolean deleteStart(String conn, String extId);

    /** An attachment downloaded with a start, kept until /alfred-setup links the board (24 h at most). */
    record PendingFile(String name, String mime, long size, byte[] data) {
    }

    void putPending(String conn, String extId, List<PendingFile> files);

    /** The item's pending files, removed from the store as they are read. */
    List<PendingFile> takePending(String conn, String extId);

    List<PendingFile> pending(String conn, String extId);

    void deletePending(String conn, String extId, String name);

    // ---------------------------------------------------------------------------------------------------- retention

    /** Trims syncs (50 per item), decided Incoming (90 days), ended bundles (180 days), waiting ids (7 days), pending files (24 h). */
    int trim(Instant now);
}
