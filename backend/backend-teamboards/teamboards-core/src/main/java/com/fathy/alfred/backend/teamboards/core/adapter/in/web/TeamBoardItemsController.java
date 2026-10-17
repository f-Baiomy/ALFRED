package com.fathy.alfred.backend.teamboards.core.adapter.in.web;

import com.fathy.alfred.backend.teamboards.core.application.port.in.BoardItemsUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.IncomingUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamSearchUseCase.SearchIn;
import com.fathy.alfred.backend.teamboards.core.application.port.in.WatchRulesUseCase;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/** A board's Related items, Incoming and watch rules (specs/028 contracts "Board items", "Incoming", "Watch rules"). */
@RestController
public class TeamBoardItemsController {

    private static final String ACTOR = TeamboardsController.ACTOR_HEADER;

    private final BoardItemsUseCase items;
    private final IncomingUseCase incoming;
    private final WatchRulesUseCase rules;

    public TeamBoardItemsController(BoardItemsUseCase items, IncomingUseCase incoming, WatchRulesUseCase rules) {
        this.items = items;
        this.incoming = incoming;
        this.rules = rules;
    }

    record AddDto(@NotBlank @Size(max = 100) String conn, @Size(max = 100) String item, @Size(max = 2000) String url, Boolean asMain, Integer maxRefs,
                  @Size(max = 40) String askedIn) {
    }

    record MainDto(@NotBlank @Size(max = 100) String conn, @NotBlank @Size(max = 2000) String item, Integer maxRefs) {
    }

    record SyncDto(Boolean force) {
    }

    record IncomingDto(@NotBlank @Size(max = 100) String conn, @NotBlank @Size(max = 2000) String item) {
    }

    record CardDto(Boolean markers) {
    }

    record LinkDto(@NotBlank @Size(max = 100) String cardId, Boolean markers) {
    }

    record ProposalDto(@NotBlank @Size(max = 10) String action, @Size(max = 100) String cardId, @NotBlank @Size(max = 2000) String reason) {
    }

    record RuleDto(@NotBlank @Size(max = 120) String name, @NotBlank @Size(max = 100) String conn, SearchIn query) {
    }

    // ------------------------------------------------------------------------------------------------------- items

    @GetMapping("/teamboards/boards/{board}/items")
    public ResponseEntity<?> list(@PathVariable String board) {
        return ResponseEntity.ok(items.list(board));
    }

    @PostMapping("/teamboards/boards/{board}/items")
    public ResponseEntity<?> add(@PathVariable String board, @Valid @RequestBody AddDto body, @RequestHeader(value = ACTOR, required = false) String actor) {
        String what = body.item() != null && !body.item().isBlank() ? body.item() : body.url();
        return ResponseEntity.ok(items.add(Who.of(actor), board, body.conn(), what, Boolean.TRUE.equals(body.asMain()),
                body.maxRefs() == null ? 0 : body.maxRefs(), body.askedIn()));
    }

    @PutMapping("/teamboards/boards/{board}/main")
    public ResponseEntity<?> main(@PathVariable String board, @Valid @RequestBody MainDto body, @RequestHeader(value = ACTOR, required = false) String actor) {
        return ResponseEntity.ok(items.setMain(Who.of(actor), board, body.conn(), body.item(), body.maxRefs() == null ? 0 : body.maxRefs()));
    }

    @DeleteMapping("/teamboards/boards/{board}/items/{conn}/{item}")
    public ResponseEntity<?> unlink(@PathVariable String board, @PathVariable String conn, @PathVariable String item,
                                    @RequestParam(required = false) String newMain, @RequestHeader(value = ACTOR, required = false) String actor) {
        return ResponseEntity.ok(items.unlink(Who.of(actor), board, conn, item, newMain));
    }

    @PostMapping("/teamboards/boards/{board}/sync")
    public ResponseEntity<?> sync(@PathVariable String board, @RequestBody(required = false) SyncDto body) {
        items.syncInBackground(board, body != null && Boolean.TRUE.equals(body.force()));
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(Map.of("state", "STARTED"));
    }

    @PostMapping("/teamboards/boards/{board}/items/{conn}/{item}/keep")
    public ResponseEntity<?> keep(@PathVariable String board, @PathVariable String conn, @PathVariable String item) {
        return ResponseEntity.ok(items.keep(board, conn, item));
    }

    @GetMapping("/teamboards/boards/{board}/items/{conn}/{item}/syncs")
    public ResponseEntity<?> syncs(@PathVariable String board, @PathVariable String conn, @PathVariable String item,
                                   @RequestParam(defaultValue = "50") int limit) {
        return ResponseEntity.ok(items.syncs(conn, item, limit));
    }

    @GetMapping("/teamboards/boards/{board}/main")
    public ResponseEntity<?> mainSummary(@PathVariable String board) {
        return items.mainSummary(board).<ResponseEntity<?>>map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.noContent().build());
    }

    // ---------------------------------------------------------------------------------------------------- incoming

    @GetMapping("/teamboards/boards/{board}/incoming")
    public ResponseEntity<?> incoming(@PathVariable String board, @RequestParam(defaultValue = "false") boolean all) {
        return ResponseEntity.ok(incoming.list(board, all));
    }

    @PostMapping("/teamboards/boards/{board}/incoming")
    public ResponseEntity<?> addIncoming(@PathVariable String board, @Valid @RequestBody IncomingDto body,
                                         @RequestHeader(value = ACTOR, required = false) String actor) {
        return ResponseEntity.ok(incoming.add(Who.of(actor), board, body.conn(), body.item()));
    }

    @PostMapping("/teamboards/boards/{board}/incoming/{conn}/{item}/card")
    public ResponseEntity<?> card(@PathVariable String board, @PathVariable String conn, @PathVariable String item,
                                  @RequestBody(required = false) CardDto body, @RequestHeader(value = ACTOR, required = false) String actor) {
        return ResponseEntity.ok(Map.of("cardId", incoming.card(Who.of(actor), board, conn, item, body != null && Boolean.TRUE.equals(body.markers()))));
    }

    @PostMapping("/teamboards/boards/{board}/incoming/{conn}/{item}/link")
    public ResponseEntity<?> link(@PathVariable String board, @PathVariable String conn, @PathVariable String item, @Valid @RequestBody LinkDto body,
                                  @RequestHeader(value = ACTOR, required = false) String actor) {
        incoming.link(Who.of(actor), board, conn, item, body.cardId(), Boolean.TRUE.equals(body.markers()));
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/teamboards/boards/{board}/incoming/{conn}/{item}/ignore")
    public ResponseEntity<?> ignore(@PathVariable String board, @PathVariable String conn, @PathVariable String item,
                                    @RequestHeader(value = ACTOR, required = false) String actor) {
        incoming.ignore(Who.of(actor), board, conn, item);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/teamboards/boards/{board}/incoming/{conn}/{item}/proposal")
    public ResponseEntity<?> propose(@PathVariable String board, @PathVariable String conn, @PathVariable String item,
                                     @Valid @RequestBody ProposalDto body, @RequestHeader(value = ACTOR, required = false) String actor) {
        return ResponseEntity.ok(incoming.propose(Who.of(actor), board, conn, item, body.action(), body.cardId(), body.reason()));
    }

    // ------------------------------------------------------------------------------------------------- watch rules

    @GetMapping("/teamboards/boards/{board}/watch-rules")
    public ResponseEntity<?> rules(@PathVariable String board) {
        return ResponseEntity.ok(rules.rules(board));
    }

    @PostMapping("/teamboards/boards/{board}/watch-rules")
    public ResponseEntity<?> addRule(@PathVariable String board, @Valid @RequestBody RuleDto body,
                                     @RequestHeader(value = ACTOR, required = false) String actor) {
        if (Who.of(actor) == Who.CLAUDE) {
            throw TeamException.userOnly("Claude proposes a watch rule in the chat; the user saves it");
        }
        return ResponseEntity.status(HttpStatus.CREATED).body(rules.put(board, null, body.conn(), body.name(), body.query()));
    }

    @PutMapping("/teamboards/boards/{board}/watch-rules/{id}")
    public ResponseEntity<?> putRule(@PathVariable String board, @PathVariable long id, @Valid @RequestBody RuleDto body,
                                     @RequestHeader(value = ACTOR, required = false) String actor) {
        if (Who.of(actor) == Who.CLAUDE) {
            throw TeamException.userOnly("Claude proposes a watch rule in the chat; the user saves it");
        }
        return ResponseEntity.ok(rules.put(board, id, body.conn(), body.name(), body.query()));
    }

    @DeleteMapping("/teamboards/boards/{board}/watch-rules/{id}")
    public ResponseEntity<?> deleteRule(@PathVariable String board, @PathVariable long id,
                                        @RequestHeader(value = ACTOR, required = false) String actor) {
        if (Who.of(actor) == Who.CLAUDE) {
            throw TeamException.userOnly("Only the user deletes a watch rule");
        }
        if (!rules.delete(board, id)) {
            throw TeamException.notFound("No rule " + id);
        }
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/teamboards/boards/{board}/watch-rules/run")
    public ResponseEntity<?> runRules(@PathVariable String board, @RequestParam(defaultValue = "REFRESH") String source,
                                      @RequestHeader(value = ACTOR, required = false) String actor) {
        String s = Who.of(actor) == Who.CLAUDE ? "MCP" : source.strip().toUpperCase(java.util.Locale.ROOT);
        if (!java.util.Set.of("OPEN", "REFRESH", "MCP").contains(s)) {
            s = "REFRESH";
        }
        return ResponseEntity.ok(Map.of("new", rules.run(board, s)));
    }
}
