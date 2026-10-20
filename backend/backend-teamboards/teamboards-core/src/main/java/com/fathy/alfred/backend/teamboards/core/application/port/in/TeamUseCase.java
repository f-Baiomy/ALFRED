package com.fathy.alfred.backend.teamboards.core.application.port.in;

import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.BoardRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ConnectionRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ConnectorInfo;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.FieldMapRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Lists;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MappingKind;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MappingRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Me;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.PersonRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SprintRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SquadRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.TokenStatus;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.TypeKindRow;
import com.fathy.alfred.backend.teamboards.spi.model.Capability;
import com.fathy.alfred.backend.teamboards.spi.model.Scope;
import com.fathy.alfred.backend.teamboards.spi.model.Token;

import java.util.List;
import java.util.Optional;

/**
 * The Team tab's connections, token and filter lists (specs/028 US1, FR-001..018). Work items are never here: they are
 * read live (TeamSearchUseCase). Refusals are {@link TeamException}s.
 */
public interface TeamUseCase {

    record NewConnection(String kind, String name, String baseUrl, Scope scope) {
    }

    List<ConnectorInfo> connectors();

    List<Capability> capabilities(String kind);

    List<ConnectionRow> connections();

    ConnectionRow createConnection(NewConnection c);

    ConnectionRow updateConnection(String id, String name, Scope scope);

    boolean deleteConnection(String id);

    // ---------------------------------------------------------------------------------------------------------- token

    /** Checks the token with the tracker (who owns it), keeps it in memory until the user forgets it, reads the lists in the background. */
    TokenStatus putToken(String conn, Token token);

    TokenStatus tokenStatus(String conn);

    /** Whether Alfred holds the caller's own token of a connection (a paired user's; false for anyone else). */
    default boolean holdsMyToken(String conn) {
        return false;
    }

    boolean forgetToken(String conn);

    // ------------------------------------------------------------------------------------------------------- the lists

    /** The cached filter lists; with a live token and lists older than {@code maxAgeMinutes}, read again in the background. */
    Lists lists(String conn, int maxAgeMinutes);

    /** Reads the lists now (with the vault's token). */
    Lists refreshLists(String conn);

    List<BoardRow> boards(String conn);

    List<SprintRow> sprints(String conn);

    List<SquadRow> squads(String conn);

    List<PersonRow> people(String conn);

    SquadRow mapSquad(String conn, String extId, String alfredProject, String alfredTeam);

    // ------------------------------------------------------------------------------------------------------------ me

    /** Who "me" is: the person marked "This is me", else the token's owner; empty with neither. */
    Optional<Me> me(String conn);

    Me putMe(String conn, String person);

    void clearMe(String conn);

    // -------------------------------------------------------------------------------------------- mappings and maps

    List<MappingRow> mappings(String conn);

    MappingRow putMapping(String conn, MappingKind kind, String extValue, String alfredProject, String alfredBoard);

    boolean deleteMapping(String conn, long id);

    List<FieldMapRow> fieldMaps(String conn);

    FieldMapRow putFieldMap(FieldMapRow row);

    boolean deleteFieldMap(String conn, String itemType, String field);

    /** The type to card kind map, with the defaults for types the connection has not set (FR-056). */
    List<TypeKindRow> typeKinds(String conn);

    TypeKindRow putTypeKind(String conn, String type, String kind);

    /** The kind a type's card gets: BUG, TASK, QUESTION, NOTE, or NONE (stays in Related items). */
    String kindOf(String conn, String type);

    // ---------------------------------------------------------------------------------------------------- upgrade

    boolean upgradeNotice();

    void dismissUpgradeNotice();
}
