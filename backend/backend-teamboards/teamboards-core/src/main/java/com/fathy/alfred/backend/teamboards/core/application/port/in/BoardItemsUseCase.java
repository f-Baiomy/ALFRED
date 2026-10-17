package com.fathy.alfred.backend.teamboards.core.application.port.in;

import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardItemRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.FieldDiff;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SyncRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * A board's Related items (specs/028 US2, FR-030..041): one main item of any type (★) with its whole tree - ancestors,
 * every descendant, one hop of other links - as references, and the items linked to the board's cards. Only the main
 * and card-linked items keep a full copy; a reference keeps id, type, title and state.
 */
public interface BoardItemsUseCase {

    int MAX_REFS = 200;
    int MAX_REFS_ASKED = 1000;

    /** One row of the tab: the board item, whether a full copy is kept, and whether Azure moved past it. */
    record ItemRow(BoardItemRow row, boolean hasCopy, Integer copyRev, boolean changed, List<String> cards) {
    }

    record View(String boardId, ItemRow main, List<ItemRow> items, Instant syncedAt, boolean live) {
    }

    View list(String boardId);

    /**
     * Adds an item (by id or tracker URL). The board's first item becomes its main. {@code maxRefs} above 200 only when
     * the user said yes to a big tree (ASK otherwise). As Claude without {@code askedIn} naming the user's request, the
     * link becomes a bundle step the user approves.
     */
    View add(Who who, String boardId, String conn, String itemOrUrl, boolean asMain, int maxRefs, String askedIn);

    record MainChange(View view, boolean reseedOffer, String oldMain) {
    }

    /** Re-roots the tree on another item (FR-031); the old main stays as a reference (or a card item). */
    MainChange setMain(Who who, String boardId, String conn, String item, int maxRefs);

    /** Unlinks an item; the main only with {@code newMain} naming the next one (or when it is the board's only item). */
    View unlink(Who who, String boardId, String conn, String item, String newMain);

    /**
     * What a sync found (specs/030 D4): counts, and for "Refresh from Azure" the items new in the main's tree (they went
     * to Incoming as before), the items whose copy Azure moved past (with how many comments are new), the main's state or
     * iteration move, and how many card matches are proposed now.
     */
    record SyncResult(String boardId, int checked, int changed, int newInTree, int leftTree, boolean skipped, List<ArrivedItem> newItems,
                      List<ChangedItem> changedItems, MainState mainState, int matches) {
        public SyncResult {
            newItems = newItems == null ? List.of() : List.copyOf(newItems);
            changedItems = changedItems == null ? List.of() : List.copyOf(changedItems);
        }

        public SyncResult(String boardId, int checked, int changed, int newInTree, int leftTree, boolean skipped) {
            this(boardId, checked, changed, newInTree, leftTree, skipped, List.of(), List.of(), null, 0);
        }
    }

    /** An item that arrived in the main's tree since the last sync. */
    record ArrivedItem(String conn, String item, String type, String title, String state) {
    }

    /** A main or card item whose copy Azure moved past: the fields that differ and the comments added since the copy. */
    record ChangedItem(String conn, String item, String title, List<String> fields, int newComments) {
    }

    /**
     * The main's move in this sync: its state (with the state category, Removed / Completed / ...) and its iteration,
     * before and after. Null in the result when neither moved.
     */
    record MainState(String conn, String item, String fromState, String toState, String category, boolean closed, String fromIteration,
                     String toIteration) {
    }

    /** Syncs the main and the card items in full, the references by fields (≤ 1 a minute a board unless {@code force}). */
    SyncResult sync(String boardId, boolean force);

    /** Starts {@link #sync} after the call returns; the result arrives on /ws/teamboards (what: sync). */
    void syncInBackground(String boardId, boolean force);

    /** "Keep Azure's version": the copy becomes the item as Azure has it now. */
    View keep(String boardId, String conn, String item);

    List<SyncRow> syncs(String conn, String item, int limit);

    /** What the board slice shows for the main (027's linked item chip): the copy's neutral fields and the unkept diff. */
    record MainSummary(String conn, String item, String provider, Map<String, String> snapshot, List<FieldDiff> changes) {
    }

    Optional<MainSummary> mainSummary(String boardId);

    /** A board was deleted: its items, links and incoming go; copies nobody needs any more go too. */
    void boardDeleted(String boardId);

    /** Makes the item a card item of the board (a card links it): adds the row or raises a reference to CARD. */
    void cardItem(String boardId, String conn, String item);

    /** The board's references that the given item no longer needs as CARD: back to REF, or gone when added only for it. */
    void cardItemGone(String boardId, String conn, String item);
}
