package com.fathy.alfred.backend.teamboards.core.adapter.in.web;

import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamUseCase.NewConnection;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamUseCase.Result;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.FieldMapRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.ItemQuery;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.MappingKind;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.RefreshResult;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.SeedTarget;
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
 * The Team tab's API (specs/027 contracts/teamboards-rest.md). The token comes in {@code X-Alfred-Team-Token} on the
 * calls that reach the provider, is used and dropped - never logged, stored or echoed. Writes sit behind the edit rule
 * (backend-app), so the tunnel can never make them.
 */
@RestController
public class TeamboardsController {

    public static final String TOKEN_HEADER = "X-Alfred-Team-Token";
    public static final String WHO_HEADER = "X-Alfred-Team-Who";

    private final TeamUseCase team;

    public TeamboardsController(TeamUseCase team) {
        this.team = team;
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

    record SquadMapDto(@Size(max = 200) String alfredProject, @Size(max = 200) String alfredTeam) {
    }

    record MappingDto(@NotBlank String kind, @NotBlank @Size(max = 300) String extValue, @NotBlank @Size(max = 200) String alfredProject,
                      @Size(max = 200) String alfredBoard) {
    }

    record FieldMapDto(@NotBlank String target) {
    }

    private static Token token(String header) {
        return header == null || header.isBlank() ? null : new Token(header.strip());
    }

    static ResponseEntity<?> error(HttpStatus status, String code, String message) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", code);
        body.put("message", message == null ? "" : message);
        return ResponseEntity.status(status).body(body);
    }

    static <T> ResponseEntity<?> respond(Result<T> r) {
        return switch (r.outcome()) {
            case OK -> ResponseEntity.ok(r.value());
            case NOT_FOUND -> error(HttpStatus.NOT_FOUND, "NOT_FOUND", r.message());
            case NOT_SUPPORTED -> error(HttpStatus.NOT_FOUND, "NOT_SUPPORTED", r.message());
            case INVALID -> error(HttpStatus.BAD_REQUEST, "INVALID", r.message());
        };
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

    @PostMapping("/teamboards/connections")
    public ResponseEntity<?> create(@Valid @RequestBody NewConnectionDto body) {
        Result<?> r = team.createConnection(new NewConnection(body.kind().strip().toLowerCase(Locale.ROOT), body.name(), body.baseUrl(),
                body.scope() == null ? null : body.scope().scope()));
        return r.outcome() == TeamUseCase.Outcome.OK ? ResponseEntity.status(HttpStatus.CREATED).body(r.value()) : respond(r);
    }

    @PatchMapping("/teamboards/connections/{id}")
    public ResponseEntity<?> update(@PathVariable String id, @Valid @RequestBody UpdateConnectionDto body) {
        return respond(team.updateConnection(id, body.name(), body.scope() == null ? null : body.scope().scope()));
    }

    @DeleteMapping("/teamboards/connections/{id}")
    public ResponseEntity<?> delete(@PathVariable String id) {
        return team.deleteConnection(id) ? ResponseEntity.noContent().build() : error(HttpStatus.NOT_FOUND, "NOT_FOUND", "No such connection");
    }

    @PostMapping("/teamboards/connections/{id}/refresh")
    public ResponseEntity<?> refresh(@PathVariable String id, @RequestHeader(value = TOKEN_HEADER, required = false) String token,
                                     @RequestHeader(value = WHO_HEADER, required = false) String who,
                                     @RequestParam(defaultValue = "false") boolean background) {
        RefreshResult r = background ? team.refreshInBackground(id, token(token), who) : team.refresh(id, token(token), who);
        return switch (r.outcome()) {
            case OK -> ResponseEntity.ok(Map.of("changed", r.changed(), "fetchedAt", r.fetchedAt().toString()));
            case STARTED -> ResponseEntity.status(HttpStatus.ACCEPTED).body(Map.of("state", "STARTED", "message", r.message()));
            case TOKEN_MISSING -> error(HttpStatus.UNAUTHORIZED, "TOKEN_MISSING", r.message());
            case TOKEN_REJECTED -> error(HttpStatus.FORBIDDEN, "TOKEN_REJECTED", r.message());
            case PROVIDER_BUSY -> {
                Map<String, Object> body = new LinkedHashMap<>();
                body.put("error", "PROVIDER_BUSY");
                body.put("message", r.message());
                body.put("retryAfter", r.retryAfter() == null ? 30 : r.retryAfter());
                yield ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS).body(body);
            }
            case NOT_FOUND -> error(HttpStatus.NOT_FOUND, "NOT_FOUND", r.message());
            case UNREACHABLE -> error(HttpStatus.BAD_GATEWAY, "UNREACHABLE", r.message());
            case BAD_RESPONSE -> error(HttpStatus.BAD_GATEWAY, "BAD_RESPONSE", r.message());
        };
    }

    // ----------------------------------------------------------------------------------------------------------- items

    @GetMapping("/teamboards/connections/{id}/items")
    public ResponseEntity<?> items(@PathVariable String id, @RequestParam(required = false) String q, @RequestParam(required = false) String type,
                                   @RequestParam(required = false) String squad, @RequestParam(required = false) String state,
                                   @RequestParam(required = false) String assignee, @RequestParam(required = false) String sprint,
                                   @RequestParam(defaultValue = "0") int offset, @RequestParam(defaultValue = "50") int limit) {
        return ResponseEntity.ok(team.items(new ItemQuery(id, q, type, squad, state, assignee, sprint, offset, limit)));
    }

    @GetMapping("/teamboards/items/{conn}/{extId}")
    public ResponseEntity<?> item(@PathVariable String conn, @PathVariable String extId) {
        return team.item(conn, extId).<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> error(HttpStatus.NOT_FOUND, "NOT_FOUND", "No such item in the cache - Refresh first"));
    }

    /** The cached history only: a GET never reaches the provider or writes, so it stays read-only through the tunnel. */
    @GetMapping("/teamboards/items/{conn}/{extId}/revisions")
    public ResponseEntity<?> revisions(@PathVariable String conn, @PathVariable String extId) {
        return respond(team.revisions(conn, extId, null, false));
    }

    /** Fetches the history with the viewer's token into the cache (a write: the edit rule applies). */
    @PostMapping("/teamboards/items/{conn}/{extId}/revisions/fetch")
    public ResponseEntity<?> fetchRevisions(@PathVariable String conn, @PathVariable String extId,
                                            @RequestHeader(value = TOKEN_HEADER, required = false) String token) {
        Token t = token(token);
        if (t == null || t.blank()) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(Map.of("error", "TOKEN_MISSING", "message", "Add your personal access token first"));
        }
        return respond(team.revisions(conn, extId, t, true));
    }

    @GetMapping("/teamboards/connections/{id}/boards")
    public ResponseEntity<?> boards(@PathVariable String id) {
        return respond(team.boards(id));
    }

    @GetMapping("/teamboards/connections/{id}/sprints")
    public ResponseEntity<?> sprints(@PathVariable String id) {
        return respond(team.sprints(id));
    }

    @GetMapping("/teamboards/connections/{id}/squads")
    public ResponseEntity<?> squads(@PathVariable String id) {
        return respond(team.squads(id));
    }

    @GetMapping("/teamboards/connections/{id}/people")
    public ResponseEntity<?> people(@PathVariable String id) {
        return ResponseEntity.ok(team.people(id));
    }

    @PatchMapping("/teamboards/squads/{conn}/{extId}")
    public ResponseEntity<?> mapSquad(@PathVariable String conn, @PathVariable String extId, @Valid @RequestBody SquadMapDto body) {
        return respond(team.mapSquad(conn, extId, body.alfredProject(), body.alfredTeam()));
    }

    @GetMapping("/teamboards/connections/{id}/changes")
    public ResponseEntity<?> changes(@PathVariable String id, @RequestParam(required = false) String squad,
                                     @RequestParam(required = false) String person, @RequestParam(required = false) Long after,
                                     @RequestParam(defaultValue = "100") int limit) {
        return ResponseEntity.ok(team.changes(id, squad, person, after, limit));
    }

    @PostMapping("/teamboards/connections/{id}/seen")
    public ResponseEntity<?> seen(@PathVariable String id) {
        return team.markSeen(id) ? ResponseEntity.noContent().build() : error(HttpStatus.NOT_FOUND, "NOT_FOUND", "No such connection");
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
            return error(HttpStatus.BAD_REQUEST, "INVALID", "kind is SPRINT, SQUAD, AREA or PROJECT");
        }
        return respond(team.putMapping(id, kind, body.extValue(), body.alfredProject(), body.alfredBoard()));
    }

    @DeleteMapping("/teamboards/connections/{id}/mappings/{mid}")
    public ResponseEntity<?> deleteMapping(@PathVariable String id, @PathVariable long mid) {
        return team.deleteMapping(id, mid) ? ResponseEntity.noContent().build() : error(HttpStatus.NOT_FOUND, "NOT_FOUND", "No such mapping");
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
            return error(HttpStatus.BAD_REQUEST, "INVALID", "target is PURPOSE, STEPS, ACCEPTANCE or CONTEXT");
        }
        return respond(team.putFieldMap(new FieldMapRow(id, type, field, target)));
    }

    @DeleteMapping("/teamboards/connections/{id}/field-maps/{type}/{field}")
    public ResponseEntity<?> deleteFieldMap(@PathVariable String id, @PathVariable String type, @PathVariable String field) {
        return team.deleteFieldMap(id, type, field) ? ResponseEntity.noContent().build()
                : error(HttpStatus.NOT_FOUND, "NOT_FOUND", "No such field map");
    }
}
