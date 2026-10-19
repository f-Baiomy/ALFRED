package com.fathy.alfred.backend.teamboards.core.adapter.in.web;

import com.fathy.alfred.backend.teamboards.core.application.port.in.PeopleUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamUseCase.NewConnection;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.FieldMapRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MappingKind;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SeedTarget;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who;
import com.fathy.alfred.backend.teamboards.spi.model.Scope;
import com.fathy.alfred.backend.teamboards.spi.model.Token;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The Team tab's connections, token, filter lists, people and mappings (specs/028 contracts/teamboards-rest.md). The
 * token comes in once, in a PUT body, and lives in the backend's memory; it is never echoed, logged or stored. Writes sit
 * behind the edit rule (backend-app), so the tunnel can never make them.
 */
@RestController
public class TeamboardsController {

    public static final String ACTOR_HEADER = "X-Alfred-Actor";

    private final TeamUseCase team;
    private final PeopleUseCase people;

    public TeamboardsController(TeamUseCase team, PeopleUseCase people) {
        this.team = team;
        this.people = people;
    }

    record ScopeDto(@Size(max = Scope.MAX_PROJECTS) List<@NotNull @Size(max = 200) String> projects,
                    @Size(max = Scope.MAX_TEAMS) List<@NotNull @Size(max = 200) String> teams) {
        Scope scope() {
            return new Scope(projects, teams);
        }
    }

    record NewConnectionDto(@NotBlank @Size(max = 40) String kind, @Size(max = 120) String name, @NotBlank @Size(max = 500) String baseUrl,
                            @Valid ScopeDto scope) {
    }

    record UpdateConnectionDto(@Size(max = 120) String name, @Valid ScopeDto scope) {
    }

    record TokenDto(@NotBlank @Size(max = 1000) String token) {
        @Override
        public String toString() {
            return "TokenDto[***]";
        }
    }

    record SquadMapDto(@Size(max = 200) String alfredProject, @Size(max = 200) String alfredTeam) {
    }

    record MappingDto(@NotBlank String kind, @NotBlank @Size(max = 300) String extValue, @NotBlank @Size(max = 200) String alfredProject,
                      @Size(max = 200) String alfredBoard) {
    }

    record FieldMapDto(@NotBlank String target) {
    }

    record MeDto(@NotBlank @Size(max = 200) String person) {
    }

    record TypeKindDto(@NotBlank @Size(max = 200) String type, @NotBlank @Size(max = 20) String kind) {
    }

    static Who who(String actor) {
        return Who.of(actor);
    }

    // ----------------------------------------------------------------------------------------------------- connections

    @GetMapping("/teamboards/connectors")
    public ResponseEntity<?> connectors() {
        return ResponseEntity.ok(team.connectors());
    }

    @GetMapping("/teamboards/connections")
    public ResponseEntity<?> connections() {
        return ResponseEntity.ok(team.connections());
    }

    @GetMapping("/teamboards/upgrade-notice")
    public ResponseEntity<?> upgradeNotice() {
        return ResponseEntity.ok(Map.of("show", team.upgradeNotice()));
    }

    @DeleteMapping("/teamboards/upgrade-notice")
    public ResponseEntity<?> dismissUpgradeNotice() {
        team.dismissUpgradeNotice();
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/teamboards/connections")
    public ResponseEntity<?> create(@Valid @RequestBody NewConnectionDto body) {
        return ResponseEntity.status(HttpStatus.CREATED).body(team.createConnection(new NewConnection(body.kind().strip().toLowerCase(Locale.ROOT),
                body.name(), body.baseUrl(), body.scope() == null ? null : body.scope().scope())));
    }

    @PatchMapping("/teamboards/connections/{id}")
    public ResponseEntity<?> update(@PathVariable String id, @Valid @RequestBody UpdateConnectionDto body) {
        return ResponseEntity.ok(team.updateConnection(id, body.name(), body.scope() == null ? null : body.scope().scope()));
    }

    @DeleteMapping("/teamboards/connections/{id}")
    public ResponseEntity<?> delete(@PathVariable String id) {
        if (!team.deleteConnection(id)) {
            throw TeamException.notFound("No such connection");
        }
        return ResponseEntity.noContent().build();
    }

    // ---------------------------------------------------------------------------------------------------------- token

    @PutMapping("/teamboards/connections/{id}/token")
    public ResponseEntity<?> putToken(@PathVariable String id, @Valid @RequestBody TokenDto body,
                                      @RequestHeader(value = ACTOR_HEADER, required = false) String actor) {
        if (who(actor) == Who.CLAUDE) {
            throw TeamException.userOnly("Claude never holds a token - the user enters it in the Team tab");
        }
        return ResponseEntity.ok(team.putToken(id, new Token(body.token())));
    }

    record MyTokenDto(@NotBlank @Size(max = 1000) String token, @Size(max = 200) String connectionId) {
        @Override
        public String toString() {
            return "MyTokenDto[***]";
        }
    }

    /**
     * A paired user's own token (specs/031), handed over by their helper from the PC where it is kept encrypted: used for
     * that user's requests only. The connection named, else the first one.
     */
    @PutMapping("/teamboards/me/token")
    public ResponseEntity<?> putMyToken(@Valid @RequestBody MyTokenDto body, @RequestHeader(value = ACTOR_HEADER, required = false) String actor) {
        if (who(actor) == Who.CLAUDE) {
            throw TeamException.userOnly("Claude never holds a token");
        }
        String conn = body.connectionId() != null && !body.connectionId().isBlank() ? body.connectionId()
                : team.connections().stream().findFirst().map(c -> c.id()).orElseThrow(() -> TeamException.notFound("No tracker connection yet"));
        return ResponseEntity.ok(team.putToken(conn, new Token(body.token())));
    }

    /**
     * Whether Alfred still holds the caller's own token (the connection named, else the first one): the helper asks on
     * its heartbeat and hands the token it keeps over again when it is gone, so the user enters it once per PC.
     */
    @GetMapping("/teamboards/me/token")
    public ResponseEntity<?> myToken(@RequestParam(required = false) String connectionId) {
        String conn = connectionId != null && !connectionId.isBlank() ? connectionId
                : team.connections().stream().findFirst().map(c -> c.id()).orElse(null);
        java.util.Map<String, Object> out = new java.util.LinkedHashMap<>();
        out.put("connection", conn);
        java.time.Instant until = conn == null ? null : team.myTokenUntil(conn).orElse(null);
        out.put("live", until != null);
        out.put("until", until);
        return ResponseEntity.ok(out);
    }

    @DeleteMapping("/teamboards/me/token")
    public ResponseEntity<?> forgetMyToken(@RequestHeader(value = ACTOR_HEADER, required = false) String actor) {
        if (Who.of(actor) == Who.CLAUDE) {
            throw TeamException.userOnly("Only the user forgets the token");
        }
        team.connections().forEach(c -> team.forgetToken(c.id()));
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/teamboards/connections/{id}/token")
    public ResponseEntity<?> tokenStatus(@PathVariable String id) {
        return ResponseEntity.ok(team.tokenStatus(id));
    }

    @DeleteMapping("/teamboards/connections/{id}/token")
    public ResponseEntity<?> forget(@PathVariable String id, @RequestHeader(value = ACTOR_HEADER, required = false) String actor) {
        if (Who.of(actor) == Who.CLAUDE) {
            throw TeamException.userOnly("Only the user forgets the token");
        }
        team.forgetToken(id);
        return ResponseEntity.noContent().build();
    }

    // ------------------------------------------------------------------------------------------------------- the lists

    @GetMapping("/teamboards/connections/{id}/lists")
    public ResponseEntity<?> lists(@PathVariable String id, @RequestParam(defaultValue = "10") int maxAgeMinutes) {
        return ResponseEntity.ok(team.lists(id, maxAgeMinutes));
    }

    @PostMapping("/teamboards/connections/{id}/lists/refresh")
    public ResponseEntity<?> refreshLists(@PathVariable String id) {
        return ResponseEntity.ok(team.refreshLists(id));
    }

    @GetMapping("/teamboards/connections/{id}/boards")
    public ResponseEntity<?> boards(@PathVariable String id) {
        return ResponseEntity.ok(team.boards(id));
    }

    @GetMapping("/teamboards/connections/{id}/sprints")
    public ResponseEntity<?> sprints(@PathVariable String id) {
        return ResponseEntity.ok(team.sprints(id));
    }

    @GetMapping("/teamboards/connections/{id}/squads")
    public ResponseEntity<?> squads(@PathVariable String id) {
        return ResponseEntity.ok(team.squads(id));
    }

    @GetMapping("/teamboards/connections/{id}/people")
    public ResponseEntity<?> people(@PathVariable String id) {
        return ResponseEntity.ok(team.people(id));
    }

    @GetMapping("/teamboards/connections/{id}/people/{person}")
    public ResponseEntity<?> person(@PathVariable String id, @PathVariable String person) {
        return ResponseEntity.ok(people.person(id, person));
    }

    @PatchMapping("/teamboards/squads/{conn}/{extId}")
    public ResponseEntity<?> mapSquad(@PathVariable String conn, @PathVariable String extId, @Valid @RequestBody SquadMapDto body) {
        return ResponseEntity.ok(team.mapSquad(conn, extId, body.alfredProject(), body.alfredTeam()));
    }

    // ------------------------------------------------------------------------------------------------------------ me

    @GetMapping("/teamboards/connections/{id}/me")
    public ResponseEntity<?> me(@PathVariable String id) {
        return team.me(id).<ResponseEntity<?>>map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.noContent().build());
    }

    @PutMapping("/teamboards/connections/{id}/me")
    public ResponseEntity<?> putMe(@PathVariable String id, @Valid @RequestBody MeDto body,
                                   @RequestHeader(value = ACTOR_HEADER, required = false) String actor) {
        if (who(actor) == Who.CLAUDE) {
            throw TeamException.userOnly("Only the user says who they are");
        }
        return ResponseEntity.ok(team.putMe(id, body.person()));
    }

    @DeleteMapping("/teamboards/connections/{id}/me")
    public ResponseEntity<?> clearMe(@PathVariable String id, @RequestHeader(value = ACTOR_HEADER, required = false) String actor) {
        if (Who.of(actor) == Who.CLAUDE) {
            throw TeamException.userOnly("Only the user says who \"me\" is");
        }
        team.clearMe(id);
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/teamboards/connections/{id}/mine")
    public ResponseEntity<?> mine(@PathVariable String id) {
        return ResponseEntity.ok(people.mine(id));
    }

    // ------------------------------------------------------------------------------------------------ mappings, fields

    @GetMapping("/teamboards/connections/{id}/mappings")
    public ResponseEntity<?> mappings(@PathVariable String id) {
        return ResponseEntity.ok(team.mappings(id));
    }

    @PutMapping("/teamboards/connections/{id}/mappings")
    public ResponseEntity<?> putMapping(@PathVariable String id, @Valid @RequestBody MappingDto body) {
        MappingKind kind;
        try {
            kind = MappingKind.valueOf(body.kind().strip().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw TeamException.invalid("kind is SPRINT, SQUAD, AREA or PROJECT");
        }
        return ResponseEntity.ok(team.putMapping(id, kind, body.extValue(), body.alfredProject(), body.alfredBoard()));
    }

    @DeleteMapping("/teamboards/connections/{id}/mappings/{mid}")
    public ResponseEntity<?> deleteMapping(@PathVariable String id, @PathVariable long mid) {
        if (!team.deleteMapping(id, mid)) {
            throw TeamException.notFound("No such mapping");
        }
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/teamboards/connections/{id}/field-maps")
    public ResponseEntity<?> fieldMaps(@PathVariable String id) {
        return ResponseEntity.ok(team.fieldMaps(id));
    }

    @PutMapping("/teamboards/connections/{id}/field-maps/{type}/{field}")
    public ResponseEntity<?> putFieldMap(@PathVariable String id, @PathVariable String type, @PathVariable String field,
                                         @Valid @RequestBody FieldMapDto body) {
        SeedTarget target;
        try {
            target = SeedTarget.valueOf(body.target().strip().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            throw TeamException.invalid("target is PURPOSE, STEPS, ACCEPTANCE or CONTEXT");
        }
        return ResponseEntity.ok(team.putFieldMap(new FieldMapRow(id, type, field, target)));
    }

    @DeleteMapping("/teamboards/connections/{id}/field-maps/{type}/{field}")
    public ResponseEntity<?> deleteFieldMap(@PathVariable String id, @PathVariable String type, @PathVariable String field) {
        if (!team.deleteFieldMap(id, type, field)) {
            throw TeamException.notFound("No such field map");
        }
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/teamboards/connections/{id}/type-kinds")
    public ResponseEntity<?> typeKinds(@PathVariable String id) {
        return ResponseEntity.ok(team.typeKinds(id));
    }

    @PutMapping("/teamboards/connections/{id}/type-kinds")
    public ResponseEntity<?> putTypeKind(@PathVariable String id, @Valid @RequestBody TypeKindDto body) {
        return ResponseEntity.ok(team.putTypeKind(id, body.type(), body.kind()));
    }

    static Map<String, Object> map(Object... kv) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (int i = 0; i + 1 < kv.length; i += 2) {
            out.put(String.valueOf(kv[i]), kv[i + 1]);
        }
        return out;
    }
}
