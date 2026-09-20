package com.fathy.alfred.backend.interception.adapter.in.web;

import com.fathy.alfred.backend.interception.adapter.in.web.dto.InterceptionRuleRequestDto;
import com.fathy.alfred.backend.interception.application.port.in.ManageInterceptionRulesUseCase;
import com.fathy.alfred.backend.interception.domain.model.ActionType;
import com.fathy.alfred.backend.interception.domain.model.FailureMode;
import com.fathy.alfred.backend.interception.domain.model.InterceptionRule;
import com.fathy.alfred.backend.interception.domain.model.RuleImportResult;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Arrays;
import java.util.List;
import java.util.Map;

/** CRUD for interception rules, plus the master switch. */
@RestController
@RequestMapping("/interception")
public class InterceptionRulesController {

    private final ManageInterceptionRulesUseCase rules;

    public InterceptionRulesController(ManageInterceptionRulesUseCase rules) {
        this.rules = rules;
    }

    @GetMapping("/rules")
    public List<InterceptionRule> list() {
        return rules.list();
    }

    @GetMapping("/rules/{id}")
    public ResponseEntity<InterceptionRule> get(@PathVariable String id) {
        return rules.get(id).map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @PostMapping("/rules")
    public ResponseEntity<InterceptionRule> create(@Valid @RequestBody InterceptionRuleRequestDto dto) {
        return ResponseEntity.ok(rules.create(dto.toDomain()));
    }

    @PutMapping("/rules/{id}")
    public ResponseEntity<InterceptionRule> update(@PathVariable String id,
                                                   @Valid @RequestBody InterceptionRuleRequestDto dto) {
        return rules.update(id, dto.toDomain())
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @DeleteMapping("/rules/{id}")
    public ResponseEntity<Void> delete(@PathVariable String id) {
        return rules.delete(id) ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build();
    }

    @PostMapping("/rules/{id}/enabled")
    public ResponseEntity<InterceptionRule> setEnabled(@PathVariable String id,
                                                       @RequestBody Map<String, Boolean> body) {
        boolean enabled = Boolean.TRUE.equals(body.get("enabled"));
        return rules.setEnabled(id, enabled)
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /**
     * Creates every rule in an exported file that can be created.
     *
     * <p>Deliberately NOT {@code @Valid} on the nested rules. Bean Validation on a list fails the
     * whole request for one bad element, which is exactly the behaviour this endpoint exists to
     * avoid - RuleValidator checks each rule on its own (including the blank name the DTO
     * annotation would have caught) and the file's good rules are created regardless.
     */
    @PostMapping("/rules/import")
    public RuleImportResult importRules(@RequestBody ImportRequestDto body) {
        List<InterceptionRule> rules = body.rules() == null
                ? List.of()
                : body.rules().stream().map(InterceptionRuleRequestDto::toDomain).toList();
        return this.rules.importRules(rules, Boolean.TRUE.equals(body.enable()));
    }

    /**
     * {@code enable} is a Boolean, not a boolean: absent has to mean OFF, and it reads as a
     * deliberate default rather than an accident of primitive initialisation. A file can carry a
     * rule that holds real callers open.
     */
    public record ImportRequestDto(List<InterceptionRuleRequestDto> rules, Boolean enable) {
    }

    @PostMapping("/rules/reorder")
    public List<InterceptionRule> reorder(@RequestBody Map<String, List<String>> body) {
        return rules.reorder(body.getOrDefault("ids", List.of()));
    }

    /**
     * The master switch, as its own resource rather than a field on some settings blob, because
     * the UI's "Turn all off" needs to be one unambiguous call that cannot accidentally carry a
     * stale copy of anything else.
     */
    @GetMapping("/enabled")
    public Map<String, Boolean> isEnabled() {
        return Map.of("enabled", rules.isMasterSwitchOn());
    }

    @PostMapping("/enabled")
    public Map<String, Boolean> setEnabled(@RequestBody Map<String, Boolean> body) {
        rules.setMasterSwitch(Boolean.TRUE.equals(body.get("enabled")));
        return Map.of("enabled", rules.isMasterSwitchOn());
    }

    /**
     * What the rule editor's action picker is built from, so the list of available actions lives
     * in exactly one place. A frontend hardcoding its own copy would drift the first time an
     * action is added, and the symptom would be a working backend action nobody can select.
     */
    @GetMapping("/action-types")
    public List<Map<String, Object>> actionTypes() {
        return Arrays.stream(ActionType.values())
                .map(type -> Map.<String, Object>of(
                        "type", type.name(),
                        "phase", type.phase().name().toLowerCase(),
                        "terminal", type.isTerminal(),
                        "pause", type.isPause(),
                        // Sent rather than filtered out: a rule already using ABORT_REQUEST still
                        // has to be rendered and labelled, it just is not offered for a new one.
                        "selectable", type.isSelectable()))
                .toList();
    }

    /**
     * The failure modes SIMULATE_FAILURE can take, for the same reason as the action list: one
     * place. The set is small and fixed, and the UI needs it to build a picker rather than a text
     * field somebody can misspell.
     */
    @GetMapping("/failure-modes")
    public List<Map<String, Object>> failureModes() {
        return Arrays.stream(FailureMode.values())
                .map(mode -> Map.<String, Object>of("mode", mode.name()))
                .toList();
    }

    /**
     * Returns every problem at once rather than the first, because a rule form has many fields and
     * fixing them one round trip at a time is the frustrating version of this.
     */
    @ExceptionHandler(ManageInterceptionRulesUseCase.InvalidRuleException.class)
    public ResponseEntity<Map<String, Object>> invalid(ManageInterceptionRulesUseCase.InvalidRuleException e) {
        return ResponseEntity.badRequest().body(Map.of(
                "error", "invalid-rule",
                "problems", e.problems()));
    }
}
