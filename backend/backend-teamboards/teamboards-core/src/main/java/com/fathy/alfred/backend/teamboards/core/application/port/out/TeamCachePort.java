package com.fathy.alfred.backend.teamboards.core.application.port.out;

import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardLinkRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ChangeRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.FieldMapRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemQuery;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemSummary;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemsPage;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MappingKind;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MappingRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.PersonRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.RevisionRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SprintRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SquadRow;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.Link;
import com.fathy.alfred.backend.teamboards.spi.model.Scope;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * teamboards.db (specs/027 data-model.md Part 2): what anyone fetched is shared by everyone; never a token. Lists read
 * summaries only - the raw item ({@code native_json}) is written, never listed.
 */
public interface TeamCachePort {

    /** A stored connection, as the store has it. */
    record StoredConnection(String id, String kind, String name, String baseUrl, Scope scope, Instant fetchedAt, String fetchedBy,
                            Instant seenAt, Instant createdAt) {
    }

    // connections
    List<StoredConnection> connections();

    Optional<StoredConnection> connection(String id);

    void putConnection(StoredConnection c);

    boolean deleteConnection(String id);

    void markFetched(String id, Instant at, String by);

    void markSeen(String id, Instant at);

    int changesAfter(String conn, Instant after);

    // items
    /** The stored rev of each item of {@code extIds} (absent: not cached yet). */
    Map<String, Integer> revs(String conn, List<String> extIds);

    /** The item's neutral fields as stored before an update, for the changes summary. */
    Optional<ItemSummary> summary(String conn, String extId);

    /** One page of items, written in one transaction (fields, links and the search index with it). */
    void upsertItems(String conn, List<Item> items, Instant fetchedAt);

    ItemsPage items(ItemQuery q);

    Map<String, String> fields(String conn, String extId);

    List<Link> links(String conn, String extId);

    // revisions and changes
    List<RevisionRow> revisions(String conn, String extId);

    void putRevisions(String conn, String extId, List<RevisionRow> revisions);

    void addChange(String conn, String extId, int rev, String by, String squad, Instant at, String summary);

    List<ChangeRow> changes(String conn, String squad, String person, Long after, int limit);

    // people, squads, boards, sprints (replaced on each refresh)
    void replacePeople(String conn, List<PersonRow> people);

    List<PersonRow> people(String conn);

    void replaceSquads(String conn, List<SquadRow> squads);

    List<SquadRow> squads(String conn);

    boolean mapSquad(String conn, String extId, String alfredProject, String alfredTeam);

    void replaceBoards(String conn, List<BoardRow> boards);

    List<BoardRow> boards(String conn);

    void replaceSprints(String conn, List<SprintRow> sprints);

    List<SprintRow> sprints(String conn);

    // mappings and field maps
    List<MappingRow> mappings(String conn);

    MappingRow putMapping(String conn, MappingKind kind, String extValue, String alfredProject, String alfredBoard);

    boolean deleteMapping(String conn, long id);

    List<FieldMapRow> fieldMaps(String conn);

    void putFieldMap(FieldMapRow row);

    boolean deleteFieldMap(String conn, String itemType, String field);

    // board links
    Optional<BoardLinkRow> link(String alfredBoard);

    Optional<BoardLinkRow> linkOfItem(String conn, String extId);

    void putLink(BoardLinkRow row);

    void markLinkSeen(String alfredBoard, int rev);

    boolean deleteLink(String alfredBoard);

    /** Trims the cache to its limits (data-model "Retention"); items a board links are never removed. Rows removed. */
    int evict(int maxItems, int maxRevisions, int maxChangeRows, Instant changesOlderThan);
}
