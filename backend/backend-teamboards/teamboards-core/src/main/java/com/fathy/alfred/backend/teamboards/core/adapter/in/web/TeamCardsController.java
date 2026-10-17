package com.fathy.alfred.backend.teamboards.core.adapter.in.web;

import com.fathy.alfred.backend.teamboards.core.application.port.in.AzureWritesUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.AzureWritesUseCase.NewBundle;
import com.fathy.alfred.backend.teamboards.core.application.port.in.CardItemsUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.CardItemsUseCase.Markers;
import com.fathy.alfred.backend.teamboards.core.application.port.in.HookUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.MatchesUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WriteStep;
import com.fathy.alfred.backend.teamboards.spi.model.NewItem;
import jakarta.servlet.http.HttpServletRequest;
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

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import java.util.Map;

/**
 * Cards' tracker items, consent bundles and the service hook (specs/028 contracts "Cards", "Consent bundles", "Watch
 * rules and hook"). {@code POST /teamboards/hooks/azure} is the one Team write the tunnel forwards.
 */
@RestController
public class TeamCardsController {

    private static final String ACTOR = TeamboardsController.ACTOR_HEADER;

    private final CardItemsUseCase cards;
    private final AzureWritesUseCase writes;
    private final HookUseCase hook;
    private final MatchesUseCase matches;

    public TeamCardsController(CardItemsUseCase cards, AzureWritesUseCase writes, HookUseCase hook, MatchesUseCase matches) {
        this.cards = cards;
        this.writes = writes;
        this.hook = hook;
        this.matches = matches;
    }

    record MarkersDto(Boolean hyperlink, Boolean comment, Boolean tag) {
        Markers markers(Markers otherwise) {
            if (hyperlink == null && comment == null && tag == null) {
                return otherwise;
            }
            return new Markers(Boolean.TRUE.equals(hyperlink), Boolean.TRUE.equals(comment), Boolean.TRUE.equals(tag));
        }
    }

    record LinkDto(@NotBlank @Size(max = 100) String conn, @NotBlank @Size(max = 2000) String item, MarkersDto markers, @Size(max = 40) String askedIn) {
    }

    record CreateDto(@NotBlank @Size(max = 100) String conn, @Size(max = 200) String project, @NotBlank @Size(max = 200) String type,
                     @NotBlank @Size(max = 300) String title, @Size(max = 256 * 1024) String description, @Size(max = 500) String area,
                     @Size(max = 500) String iteration, @Size(max = 300) String assignee, MarkersDto markers) {
    }

    record BundleDto(@Size(max = 200) String board, @Size(max = 100) String card, @NotBlank @Size(max = 100) String conn, @Size(max = 100) String item,
                     @Size(max = 300) String title, List<WriteStep> steps, @Size(max = 40) String askedIn, Long extend) {
    }

    record EditDto(@Size(max = 300) String title, List<WriteStep> steps) {
    }

    record AddressDto(@Size(max = 300) String publicAddress) {
    }

    record WhyDto(@NotBlank @Size(max = 2000) String why) {
    }

    // -------------------------------------------------------------------------------------------------------- cards

    @GetMapping("/teamboards/cards/{card}/items")
    public ResponseEntity<?> items(@PathVariable String card) {
        return ResponseEntity.ok(cards.items(card));
    }

    @PostMapping("/teamboards/cards/{card}/items")
    public ResponseEntity<?> link(@PathVariable String card, @Valid @RequestBody LinkDto body, @RequestHeader(value = ACTOR, required = false) String actor) {
        return ResponseEntity.ok(cards.link(Who.of(actor), card, body.conn(), body.item(),
                body.markers() == null ? Markers.NONE : body.markers().markers(Markers.NONE), body.askedIn()));
    }

    @PostMapping("/teamboards/cards/{card}/create")
    public ResponseEntity<?> create(@PathVariable String card, @Valid @RequestBody CreateDto body,
                                    @RequestHeader(value = ACTOR, required = false) String actor) {
        return ResponseEntity.ok(cards.create(Who.of(actor), card, body.conn(), new NewItem(body.project(), body.type(), body.title(), body.description(),
                body.area(), body.iteration(), body.assignee()), body.markers() == null ? Markers.ALL : body.markers().markers(Markers.ALL)));
    }

    @DeleteMapping("/teamboards/cards/{card}/items/{conn}/{item}")
    public ResponseEntity<?> unlink(@PathVariable String card, @PathVariable String conn, @PathVariable String item,
                                    @RequestHeader(value = ACTOR, required = false) String actor) {
        return ResponseEntity.ok(cards.unlink(Who.of(actor), card, conn, item));
    }

    // ------------------------------------------------------------------------------------------------------ matches

    @GetMapping("/teamboards/cards/{card}/matches")
    public ResponseEntity<?> matches(@PathVariable String card) {
        return ResponseEntity.ok(matches.matches(card));
    }

    @PostMapping("/teamboards/cards/{card}/matches/{conn}/{item}/link")
    public ResponseEntity<?> linkMatch(@PathVariable String card, @PathVariable String conn, @PathVariable String item,
                                       @RequestHeader(value = ACTOR, required = false) String actor) {
        return ResponseEntity.ok(matches.link(Who.of(actor), card, conn, item));
    }

    @PostMapping("/teamboards/cards/{card}/matches/{conn}/{item}/reject")
    public ResponseEntity<?> rejectMatch(@PathVariable String card, @PathVariable String conn, @PathVariable String item,
                                         @RequestHeader(value = ACTOR, required = false) String actor) {
        return ResponseEntity.ok(matches.reject(Who.of(actor), card, conn, item));
    }

    @PutMapping("/teamboards/cards/{card}/matches/{conn}/{item}/why")
    public ResponseEntity<?> matchWhy(@PathVariable String card, @PathVariable String conn, @PathVariable String item, @Valid @RequestBody WhyDto body) {
        return ResponseEntity.ok(matches.why(card, conn, item, body.why()));
    }

    // ------------------------------------------------------------------------------------------------------ bundles

    @PostMapping("/teamboards/writes")
    public ResponseEntity<?> createBundle(@Valid @RequestBody BundleDto body, @RequestHeader(value = ACTOR, required = false) String actor) {
        return ResponseEntity.status(HttpStatus.CREATED).body(writes.create(Who.of(actor), new NewBundle(body.board(), body.card(), body.conn(),
                body.item(), body.title() == null || body.title().isBlank() ? "Changes in Azure" : body.title(), body.steps(), body.askedIn(),
                body.extend())));
    }

    @GetMapping("/teamboards/writes")
    public ResponseEntity<?> bundles(@RequestParam(required = false) String board, @RequestParam(required = false) String card,
                                     @RequestParam(required = false) String state, @RequestParam(defaultValue = "50") int limit) {
        return ResponseEntity.ok(writes.list(board, card, state, limit));
    }

    @GetMapping("/teamboards/writes/{id}")
    public ResponseEntity<?> bundle(@PathVariable long id) {
        return ResponseEntity.ok(writes.get(id).orElseThrow(() -> TeamException.notFound("No bundle " + id)));
    }

    @PutMapping("/teamboards/writes/{id}")
    public ResponseEntity<?> edit(@PathVariable long id, @Valid @RequestBody EditDto body, @RequestHeader(value = ACTOR, required = false) String actor) {
        return ResponseEntity.ok(writes.edit(Who.of(actor), id, body.title(), body.steps()));
    }

    /** The built file of an ATTACH step, as the raw body ({@code ?step=&name=}). */
    @PostMapping("/teamboards/writes/{id}/files")
    public ResponseEntity<?> file(@PathVariable long id, @RequestParam int step, @RequestParam(required = false) String name, HttpServletRequest request,
                                  @RequestHeader(value = ACTOR, required = false) String actor) throws IOException {
        long length = request.getContentLengthLong();
        if (length > AzureWritesUseCase.MAX_FILE) {
            throw TeamException.invalid("A file is at most 60 MB");
        }
        byte[] data = request.getInputStream().readNBytes((int) AzureWritesUseCase.MAX_FILE + 1);
        if (data.length > AzureWritesUseCase.MAX_FILE) {
            throw TeamException.invalid("A file is at most 60 MB");
        }
        return ResponseEntity.ok(writes.putFile(Who.of(actor), id, step, name, data));
    }

    @PostMapping("/teamboards/writes/{id}/approve")
    public ResponseEntity<?> approve(@PathVariable long id, @RequestHeader(value = ACTOR, required = false) String actor) {
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(writes.approve(Who.of(actor), id));
    }

    @PostMapping("/teamboards/writes/{id}/reject")
    public ResponseEntity<?> reject(@PathVariable long id, @RequestHeader(value = ACTOR, required = false) String actor) {
        return ResponseEntity.ok(writes.reject(Who.of(actor), id));
    }

    // --------------------------------------------------------------------------------------------------------- hook

    /** Azure's service hook: basic auth (any user, the password is the secret); 202 with nothing in it. */
    @PostMapping("/teamboards/hooks/{kind}")
    public ResponseEntity<?> ping(@PathVariable String kind, @RequestHeader(value = "Authorization", required = false) String auth,
                                  HttpServletRequest request) throws IOException {
        byte[] raw = request.getInputStream().readNBytes(256 * 1024);
        String secret = null;
        if (auth != null && auth.regionMatches(true, 0, "Basic ", 0, 6)) {
            try {
                String decoded = new String(Base64.getDecoder().decode(auth.substring(6).strip()), StandardCharsets.UTF_8);
                int colon = decoded.indexOf(':');
                secret = colon < 0 ? decoded : decoded.substring(colon + 1);
            } catch (IllegalArgumentException e) {
                secret = null;
            }
        }
        return switch (hook.ping(kind, secret, new String(raw, StandardCharsets.UTF_8))) {
            case ACCEPTED -> ResponseEntity.status(HttpStatus.ACCEPTED).build();
            case BAD_SECRET -> ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
            case TOO_MANY -> ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS).header("Retry-After", "60").build();
            case NOT_SUPPORTED -> ResponseEntity.status(HttpStatus.NOT_FOUND).build();
        };
    }

    @GetMapping("/teamboards/connections/{id}/hook")
    public ResponseEntity<?> hookInfo(@PathVariable String id) {
        return ResponseEntity.ok(hook.info(id));
    }

    @PutMapping("/teamboards/connections/{id}/hook")
    public ResponseEntity<?> putHook(@PathVariable String id, @Valid @RequestBody AddressDto body,
                                     @RequestHeader(value = ACTOR, required = false) String actor) {
        if (Who.of(actor) == Who.CLAUDE) {
            throw TeamException.userOnly("Only the user changes the hook settings");
        }
        return ResponseEntity.ok(hook.putPublicAddress(id, body.publicAddress()));
    }

    @PostMapping("/teamboards/connections/{id}/hook/secret")
    public ResponseEntity<?> rotate(@PathVariable String id, @RequestHeader(value = ACTOR, required = false) String actor) {
        if (Who.of(actor) == Who.CLAUDE) {
            throw TeamException.userOnly("Only the user rotates the hook secret");
        }
        return ResponseEntity.ok(Map.of("secret", hook.rotateSecret(id)));
    }
}
