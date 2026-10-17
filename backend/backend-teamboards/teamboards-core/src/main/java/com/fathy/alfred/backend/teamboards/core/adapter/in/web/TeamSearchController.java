package com.fathy.alfred.backend.teamboards.core.adapter.in.web;

import com.fathy.alfred.backend.teamboards.core.application.port.in.AzureWritesUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.AzureWritesUseCase.NewBundle;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamSearchUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamSearchUseCase.FileBytes;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamSearchUseCase.Part;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamSearchUseCase.SearchIn;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.StepKind;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WriteBundle;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WriteStep;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/** Live search and reads (specs/028 contracts "Search and items"); nothing of an answer is stored. */
@RestController
public class TeamSearchController {

    private final TeamSearchUseCase search;
    private final AzureWritesUseCase writes;

    public TeamSearchController(TeamSearchUseCase search, AzureWritesUseCase writes) {
        this.search = search;
        this.writes = writes;
    }

    record QueryDto(@NotBlank @Size(max = 32000) String wiql, Integer max) {
    }

    record ItemsDto(List<@NotBlank @Size(max = 100) String> ids, String include) {
    }

    /** The user's own change from the Team tab: state, comment, or both. As Claude, a waiting bundle. */
    record DirectDto(@Size(max = 200) String state, @Size(max = 64 * 1024) String comment, @Size(max = 200) String board, @Size(max = 100) String card,
                     @Size(max = 40) String askedIn) {
    }

    static Set<Part> parts(String include) {
        Set<Part> out = EnumSet.noneOf(Part.class);
        if (include == null || include.isBlank()) {
            return out;
        }
        for (String p : include.split(",")) {
            switch (p.strip().toLowerCase(Locale.ROOT)) {
                case "comments" -> out.add(Part.COMMENTS);
                case "history" -> out.add(Part.HISTORY);
                case "attachments" -> out.add(Part.ATTACHMENTS);
                case "all" -> out.addAll(EnumSet.allOf(Part.class));
                default -> {
                    // fields and relations always come
                }
            }
        }
        return out;
    }

    @PostMapping("/teamboards/connections/{id}/search")
    public ResponseEntity<?> search(@PathVariable String id, @RequestBody(required = false) SearchIn body) {
        return ResponseEntity.ok(search.search(id, body));
    }

    @PostMapping("/teamboards/connections/{id}/query")
    public ResponseEntity<?> query(@PathVariable String id, @Valid @RequestBody QueryDto body) {
        return ResponseEntity.ok(search.query(id, body.wiql(), body.max() == null ? TeamSearchUseCase.MAX_ITEMS : body.max()));
    }

    @GetMapping("/teamboards/connections/{id}/items/{item}")
    public ResponseEntity<?> item(@PathVariable String id, @PathVariable String item, @RequestParam(required = false) String include) {
        return ResponseEntity.ok(search.item(id, item, parts(include)));
    }

    @PostMapping("/teamboards/connections/{id}/items")
    public ResponseEntity<?> items(@PathVariable String id, @Valid @RequestBody ItemsDto body) {
        return ResponseEntity.ok(search.items(id, body.ids(), parts(body.include())));
    }

    @GetMapping("/teamboards/connections/{id}/items/{item}/attachments/{name}")
    public ResponseEntity<byte[]> attachment(@PathVariable String id, @PathVariable String item, @PathVariable String name) {
        FileBytes f = search.attachment(id, item, name);
        MediaType type;
        try {
            type = MediaType.parseMediaType(f.mime());
        } catch (RuntimeException e) {
            type = MediaType.APPLICATION_OCTET_STREAM;
        }
        return ResponseEntity.ok().contentType(type)
                .header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.attachment().filename(f.name(), StandardCharsets.UTF_8).build().toString())
                .header("X-Content-Type-Options", "nosniff").body(f.data());
    }

    @PatchMapping("/teamboards/connections/{id}/items/{item}")
    public ResponseEntity<?> direct(@PathVariable String id, @PathVariable String item, @Valid @RequestBody DirectDto body,
                                    @RequestHeader(value = TeamboardsController.ACTOR_HEADER, required = false) String actor) {
        List<WriteStep> steps = new ArrayList<>();
        if (body.state() != null && !body.state().isBlank()) {
            steps.add(new WriteStep(StepKind.STATE, Map.of("state", body.state().strip()), true, false, null));
        }
        if (body.comment() != null && !body.comment().isBlank()) {
            steps.add(new WriteStep(StepKind.COMMENT, Map.of("text", body.comment()), true, false, null));
        }
        if (steps.isEmpty()) {
            throw TeamException.invalid("Send a state, a comment, or both");
        }
        String title = (body.state() != null && !body.state().isBlank() ? "Move item " + item + " to " + body.state().strip() : "Comment on item " + item);
        WriteBundle b = Who.of(actor) == Who.CLAUDE
                ? writes.create(Who.CLAUDE, new NewBundle(body.board(), body.card(), id, item, title, steps, body.askedIn(), null))
                : writes.direct(id, item, body.board(), body.card(), title, steps);
        return ResponseEntity.ok(b);
    }
}
