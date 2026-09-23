package com.fathy.alfred.backend.interception.adapter.in.web;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fathy.alfred.backend.interception.adapter.in.web.dto.InterceptionRuleRequestDto;
import com.fathy.alfred.backend.interception.application.port.in.ManageInterceptionRulesUseCase;
import com.fathy.alfred.backend.interception.application.port.in.ManageStoredAnswersUseCase;
import com.fathy.alfred.backend.interception.domain.model.ActionType;
import com.fathy.alfred.backend.interception.domain.model.FailureMode;
import com.fathy.alfred.backend.interception.domain.model.InterceptionRule;
import com.fathy.alfred.backend.interception.domain.model.RuleImportResult;
import com.fathy.alfred.backend.interception.domain.model.SensitiveHeaders;
import com.fathy.alfred.backend.interception.domain.model.StoredAnswer;
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
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;

/** CRUD for interception rules, plus the master switch. */
@RestController
@RequestMapping("/interception")
public class InterceptionRulesController {

    /** The rules file format this deployment writes: 2 embeds the stored answers rules use. */
    static final int RULES_FILE_VERSION = 2;
    static final String RULES_FILE_MARKER = "alfredInterceptionRules";

    private final ManageInterceptionRulesUseCase rules;
    private final ManageStoredAnswersUseCase answers;
    private final ObjectMapper mapper;

    public InterceptionRulesController(ManageInterceptionRulesUseCase rules, ManageStoredAnswersUseCase answers,
                                       ObjectMapper mapper) {
        this.rules = rules;
        this.answers = answers;
        this.mapper = mapper;
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
        // Answers first, under fresh ids, so every answerRef in the rules can be pointed at one. An
        // answer whose rule is then rejected is left to the orphan sweep.
        Map<String, String> idsByRef = new HashMap<>();
        for (ExportedAnswerDto answer : body.answers() == null ? List.<ExportedAnswerDto>of() : body.answers()) {
            importAnswer(answer).ifPresent(id -> idsByRef.put(answer.ref(), id));
        }
        List<InterceptionRule> incoming = new ArrayList<>();
        for (JsonNode node : body.rules() == null ? List.<JsonNode>of() : body.rules()) {
            if (node != null && node.isObject()) {
                renameKey(node, "answerRef", "answerId", idsByRef::get);
            }
            try {
                incoming.add(mapper.treeToValue(node, InterceptionRuleRequestDto.class).toDomain());
            } catch (JsonProcessingException | IllegalArgumentException e) {
                throw new ManageInterceptionRulesUseCase.InvalidRuleException(
                        List.of("Rule " + (incoming.size() + 1) + " in the file is not a rule: " + e.getMessage()));
            }
        }
        return this.rules.importRules(incoming, Boolean.TRUE.equals(body.enable()));
    }

    /**
     * {@code enable} is a Boolean, not a boolean: absent has to mean OFF, and it reads as a
     * deliberate default rather than an accident of primitive initialisation. A file can carry a
     * rule that holds real callers open.
     *
     * <p>{@code rules} is read as JSON trees: a version-2 file names its answers by {@code answerRef},
     * which is rewritten to this deployment's fresh {@code answerId} before a rule is built. A
     * version-1 file, and the old {@code {rules, enable}} body, simply carry no answers. Anything
     * else in the file ({@code exportedAt}, fields a newer Alfred adds) is ignored, whatever the
     * mapper's defaults.
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record ImportRequestDto(Integer alfredInterceptionRules, List<JsonNode> rules,
                                   List<ExportedAnswerDto> answers, Boolean enable) {
    }

    /** One stored answer embedded in a rules file (contracts/rules-snapshot-and-file.md §3). */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record ExportedAnswerDto(String ref, StoredAnswer.Kind kind, Integer status, String contentType,
                                    Map<String, String> headers, Boolean secretsKept, String sourceDirection,
                                    String recordedAt, String bodyBase64) {
    }

    /**
     * A rules file with every stored answer the rules use embedded, so the file works in another
     * deployment. {@code answerId} becomes a file-local {@code answerRef}; the ids of this database
     * mean nothing anywhere else.
     */
    @GetMapping("/rules/export")
    public Map<String, Object> exportRules(@RequestParam(required = false) List<String> ids) {
        List<InterceptionRule> chosen = ids == null || ids.isEmpty()
                ? rules.list()
                : rules.list().stream().filter(rule -> ids.contains(rule.id())).toList();

        Map<String, String> refsById = new LinkedHashMap<>();
        List<JsonNode> exported = new ArrayList<>();
        for (InterceptionRule rule : chosen) {
            ObjectNode node = mapper.valueToTree(rule);
            // Server-assigned: rules always import as new rules (see toRuleDraft in the frontend).
            node.remove(List.of("id", "createdAt", "updatedAt"));
            renameKey(node, "answerId", "answerRef", id -> refsById.computeIfAbsent(id, k -> "a" + (refsById.size() + 1)));
            exported.add(node);
        }

        List<ExportedAnswerDto> embedded = new ArrayList<>();
        refsById.forEach((id, ref) -> answers.get(id).ifPresent(view -> answers.body(id).ifPresent(body -> {
            StoredAnswer answer = view.answer();
            embedded.add(new ExportedAnswerDto(ref, answer.kind(), answer.status(), answer.contentType(),
                    answer.headers(), answer.secretsKept(), answer.sourceDirection(), answer.recordedAt(),
                    Base64.getEncoder().encodeToString(body)));
        })));

        Map<String, Object> file = new LinkedHashMap<>();
        file.put(RULES_FILE_MARKER, RULES_FILE_VERSION);
        file.put("exportedAt", Instant.now().toString());
        file.put("rules", exported);
        file.put("answers", embedded);
        return file;
    }

    private Optional<String> importAnswer(ExportedAnswerDto answer) {
        if (answer == null || answer.ref() == null || answer.kind() == null || answer.bodyBase64() == null) {
            return Optional.empty();
        }
        byte[] body;
        try {
            body = Base64.getDecoder().decode(answer.bodyBase64());
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }
        StoredAnswer candidate = new StoredAnswer(null, answer.kind(), answer.status(), answer.headers(),
                answer.contentType(), body.length, answer.secretsKept(), null, answer.sourceDirection(),
                null, null, answer.recordedAt(), null);
        return answers.importAnswer(candidate, body).map(StoredAnswer::id);
    }

    /**
     * Renames {@code from} to {@code to} on every object in the tree - an answer can sit in a
     * condition's branch as easily as at the top - mapping its value on the way. A value the mapping
     * does not know becomes null, which the validator reports as a missing answer.
     */
    private static void renameKey(JsonNode node, String from, String to, Function<String, String> value) {
        if (node instanceof ObjectNode object) {
            JsonNode found = object.remove(from);
            if (found != null) {
                String mapped = found.isTextual() ? value.apply(found.asText()) : null;
                if (mapped == null) {
                    object.putNull(to);
                } else {
                    object.put(to, mapped);
                }
            }
            object.forEach(child -> renameKey(child, from, to, value));
        } else if (node != null && node.isArray()) {
            node.forEach(child -> renameKey(child, from, to, value));
        }
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
     * The secret header and cookie names, for the frontend's masking (a match test's value, a
     * stored answer's headers). The one list lives in SensitiveHeaders; the proxies receive the
     * same list in the rules snapshot, so there is no copy anywhere to fall out of step.
     */
    @GetMapping("/sensitive-headers")
    public Map<String, Object> sensitiveHeaders() {
        return Map.of("names", SensitiveHeaders.NAMES.stream().sorted().toList());
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
