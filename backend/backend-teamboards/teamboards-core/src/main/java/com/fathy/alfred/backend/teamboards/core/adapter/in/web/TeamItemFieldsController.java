package com.fathy.alfred.backend.teamboards.core.adapter.in.web;

import com.fathy.alfred.backend.teamboards.core.application.port.in.ItemFieldsUseCase;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * specs/038: a work item type's fields (FR-14), templates for new items (FR-11) and the switch that lets Claude prepare
 * Azure changes (G-8). Nothing here writes to the tracker.
 */
@RestController
public class TeamItemFieldsController {

    private static final String ACTOR = TeamboardsController.ACTOR_HEADER;

    private final ItemFieldsUseCase fields;

    public TeamItemFieldsController(ItemFieldsUseCase fields) {
        this.fields = fields;
    }

    @GetMapping("/teamboards/connections/{conn}/fields")
    public ResponseEntity<?> fields(@PathVariable String conn, @RequestParam String project, @RequestParam String type,
                                    @RequestParam(defaultValue = "false") boolean fresh) {
        return ResponseEntity.ok(fields.fields(conn, project, type, fresh));
    }

    @GetMapping("/teamboards/connections/{conn}/templates")
    public ResponseEntity<?> templates(@PathVariable String conn) {
        return ResponseEntity.ok(fields.templates(conn));
    }

    record TemplateDto(@NotBlank @Size(max = 200) String type, Map<String, String> fields) {
    }

    @PutMapping("/teamboards/connections/{conn}/templates/{name}")
    public ResponseEntity<?> putTemplate(@PathVariable String conn, @PathVariable String name, @Valid @RequestBody TemplateDto body,
                                         @RequestHeader(value = ACTOR, required = false) String actor) {
        return ResponseEntity.ok(fields.putTemplate(Who.of(actor), conn, name, body.type(), body.fields()));
    }

    @DeleteMapping("/teamboards/connections/{conn}/templates/{name}")
    public ResponseEntity<?> deleteTemplate(@PathVariable String conn, @PathVariable String name,
                                            @RequestHeader(value = ACTOR, required = false) String actor) {
        return fields.deleteTemplate(Who.of(actor), conn, name) ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build();
    }

    @GetMapping("/teamboards/settings/claude-drafts")
    public ResponseEntity<?> claudeDrafts() {
        return ResponseEntity.ok(Map.of("on", fields.claudeMayDraft()));
    }

    record SwitchDto(boolean on) {
    }

    @PutMapping("/teamboards/settings/claude-drafts")
    public ResponseEntity<?> setClaudeDrafts(@RequestBody SwitchDto body, @RequestHeader(value = ACTOR, required = false) String actor) {
        return ResponseEntity.ok(Map.of("on", fields.setClaudeMayDraft(Who.of(actor), body.on())));
    }
}
