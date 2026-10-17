package com.fathy.alfred.backend.teamboards.core.application.port.in;

import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ChangeRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ConnectionRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ConnectorInfo;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.FieldMapRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemDetail;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemQuery;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemsPage;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MappingKind;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MappingRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.PersonRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.RefreshResult;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.RevisionRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SprintRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SquadRow;
import com.fathy.alfred.backend.teamboards.spi.model.Capability;
import com.fathy.alfred.backend.teamboards.spi.model.Scope;
import com.fathy.alfred.backend.teamboards.spi.model.Token;

import java.util.List;
import java.util.Optional;

/**
 * The Team tab (specs/027 US7): connections, the shared cache and its refresh, items, history, squads, boards, sprints,
 * the changes feed, and where items open their boards. Read-only towards the provider (FR-026). The token is the
 * caller's, passed per call and never kept.
 */
public interface TeamUseCase {

    int MAX_LIMIT = 200;

    record NewConnection(String kind, String name, String baseUrl, Scope scope) {
    }

    enum Outcome { OK, NOT_FOUND, NOT_SUPPORTED, INVALID }

    record Result<T>(Outcome outcome, T value, String message) {
        public static <T> Result<T> ok(T value) {
            return new Result<>(Outcome.OK, value, null);
        }

        public static <T> Result<T> no(Outcome outcome, String message) {
            return new Result<>(outcome, null, message);
        }
    }

    List<ConnectorInfo> connectors();

    List<ConnectionRow> connections();

    Result<ConnectionRow> createConnection(NewConnection c);

    Result<ConnectionRow> updateConnection(String id, String name, Scope scope);

    boolean deleteConnection(String id);

    /** Fetches what changed since the last fetch into the shared cache. {@code who}: a name for "fetched by". */
    RefreshResult refresh(String conn, Token token, String who);

    /** The same, run on after the call returns STARTED; the outcome arrives on /ws/teamboards (what: refresh). */
    RefreshResult refreshInBackground(String conn, Token token, String who);

    ItemsPage items(ItemQuery q);

    Optional<ItemDetail> item(String conn, String extId);

    /** From the cache; with a token and none cached (or {@code fetch}) fetched first. */
    Result<List<RevisionRow>> revisions(String conn, String extId, Token token, boolean fetch);

    Result<List<BoardRow>> boards(String conn);

    Result<List<SprintRow>> sprints(String conn);

    Result<List<SquadRow>> squads(String conn);

    List<PersonRow> people(String conn);

    Result<SquadRow> mapSquad(String conn, String extId, String alfredProject, String alfredTeam);

    List<ChangeRow> changes(String conn, String squad, String person, Long after, int limit);

    boolean markSeen(String conn);

    List<MappingRow> mappings(String conn);

    Result<MappingRow> putMapping(String conn, MappingKind kind, String extValue, String alfredProject, String alfredBoard);

    boolean deleteMapping(String conn, long id);

    List<FieldMapRow> fieldMaps(String conn);

    Result<FieldMapRow> putFieldMap(FieldMapRow row);

    boolean deleteFieldMap(String conn, String itemType, String field);

    List<Capability> capabilities(String kind);
}
