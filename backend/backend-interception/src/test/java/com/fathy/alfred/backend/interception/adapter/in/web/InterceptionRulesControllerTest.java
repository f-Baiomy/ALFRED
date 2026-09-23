package com.fathy.alfred.backend.interception.adapter.in.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.interception.application.port.in.ManageStoredAnswersUseCase.CopyResult;
import com.fathy.alfred.backend.interception.application.port.out.InterceptionNotificationPort;
import com.fathy.alfred.backend.interception.application.port.out.InterceptionRulesStorePort;
import com.fathy.alfred.backend.interception.application.port.out.RecordedCallLookupPort.RecordedResponse;
import com.fathy.alfred.backend.interception.application.port.out.StoredAnswersStorePort;
import com.fathy.alfred.backend.interception.application.service.BreakpointService;
import com.fathy.alfred.backend.interception.application.service.InterceptionRulesService;
import com.fathy.alfred.backend.interception.application.service.StoredAnswersService;
import com.fathy.alfred.backend.interception.domain.model.InterceptionRule;
import com.fathy.alfred.backend.interception.domain.model.RuleImportResult;
import com.fathy.alfred.backend.interception.domain.model.SelfTargets;
import com.fathy.alfred.backend.interception.domain.model.StoredAnswer;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

/** The rules file's version 2: stored answers travel with the rules that use them. */
class InterceptionRulesControllerTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private final Map<String, StoredAnswer> answerMeta = new LinkedHashMap<>();
    private final Map<String, byte[]> answerBodies = new LinkedHashMap<>();
    private List<InterceptionRule> stored = new ArrayList<>();
    private StoredAnswersService answers;
    private InterceptionRulesController controller;

    @BeforeEach
    void setUp() {
        InterceptionRulesStorePort rules = new InterceptionRulesStorePort() {
            public List<InterceptionRule> findAll() {
                return List.copyOf(stored);
            }

            public void saveAll(List<InterceptionRule> saved) {
                stored = new ArrayList<>(saved);
            }

            public boolean isEnabled() {
                return true;
            }

            public void setEnabled(boolean enabled) {
            }
        };
        StoredAnswersStorePort store = new StoredAnswersStorePort() {
            public void save(StoredAnswer answer, byte[] body) {
                answerMeta.put(answer.id(), answer);
                answerBodies.put(answer.id(), body);
            }

            public Optional<StoredAnswer> findMeta(String id) {
                return Optional.ofNullable(answerMeta.get(id));
            }

            public Optional<byte[]> findBody(String id) {
                return Optional.ofNullable(answerBodies.get(id));
            }

            public List<StoredAnswer> listMeta() {
                return List.copyOf(answerMeta.values());
            }

            public void delete(String id) {
                answerMeta.remove(id);
                answerBodies.remove(id);
            }
        };
        InterceptionNotificationPort quiet = new InterceptionNotificationPort() {
            public void rulesChanged() {
            }

            public void pausedCallsChanged() {
            }
        };
        answers = new StoredAnswersService(store,
                (direction, callId, cycleId) -> Optional.of(new RecordedResponse(503,
                        Map.of("content-type", "application/json"), "{\"fare\":0}".getBytes(StandardCharsets.UTF_8))),
                rules, 10_485_760);
        InterceptionRulesService service = new InterceptionRulesService(rules, (enabled, all, published) -> { }, quiet,
                new BreakpointService(quiet), SelfTargets.none(), answers);
        controller = new InterceptionRulesController(service, answers, mapper);
    }

    private String copiedAnswer() {
        return ((CopyResult.Created) answers.copyFromCall("outbound", "c1", null, null)).answer().id();
    }

    /** The answer sits inside a condition's branch, so the ref rewrite has to reach nested actions. */
    private InterceptionRule replayRule(String answerId) throws Exception {
        String json = "{\"id\":\"r1\",\"name\":\"Replay\",\"enabled\":true,\"priority\":10,\"stopProcessing\":false,"
                + "\"match\":{},\"actions\":[{\"type\":\"IF_REQUEST\",\"branches\":[{\"conditions\":[{\"subject\":\"METHOD\","
                + "\"operator\":\"EQUALS\",\"value\":\"POST\"}],\"actions\":[{\"type\":\"ANSWER_WITH_RECORDED_CALL\","
                + "\"answerId\":\"" + answerId + "\"}]}]}]}";
        return mapper.readValue(json, InterceptionRule.class);
    }

    private RuleImportResult importFile(JsonNode file) throws Exception {
        return controller.importRules(mapper.treeToValue(file, InterceptionRulesController.ImportRequestDto.class));
    }

    @Test
    void exportEmbedsTheAnswerAndRefersToItByAFileLocalRef() throws Exception {
        String id = copiedAnswer();
        stored.add(replayRule(id));

        JsonNode file = mapper.valueToTree(controller.exportRules(null));

        assertThat(file.get("alfredInterceptionRules").asInt()).isEqualTo(2);
        JsonNode nested = file.get("rules").get(0).get("actions").get(0).get("branches").get(0).get("actions").get(0);
        assertThat(nested.has("answerId")).isFalse();
        assertThat(nested.get("answerRef").asText()).isEqualTo("a1");
        assertThat(file.get("rules").get(0).has("id")).isFalse();
        JsonNode answer = file.get("answers").get(0);
        assertThat(answer.get("ref").asText()).isEqualTo("a1");
        assertThat(answer.get("status").asInt()).isEqualTo(503);
        assertThat(new String(Base64.getDecoder().decode(answer.get("bodyBase64").asText()), StandardCharsets.UTF_8))
                .isEqualTo("{\"fare\":0}");
        assertThat(file.toString()).doesNotContain(id);
    }

    @Test
    void importingVersion2CreatesFreshAnswersAndRewritesTheRefs() throws Exception {
        stored.add(replayRule(copiedAnswer()));
        JsonNode file = mapper.valueToTree(controller.exportRules(null));
        stored.clear();
        answerMeta.clear();
        answerBodies.clear();

        RuleImportResult result = importFile(file);

        assertThat(result.imported()).isEqualTo(1);
        String newId = stored.get(0).answerIds().iterator().next();
        assertThat(StoredAnswer.isValidId(newId)).isTrue();
        assertThat(answerMeta).containsOnlyKeys(newId);
        assertThat(new String(answerBodies.get(newId), StandardCharsets.UTF_8)).isEqualTo("{\"fare\":0}");
    }

    @Test
    void aVersion1FileStillImports() throws Exception {
        JsonNode file = mapper.readTree("{\"alfredInterceptionRules\":1,\"rules\":[{\"name\":\"Slow\",\"match\":{},"
                + "\"actions\":[{\"type\":\"DELAY_REQUEST\",\"durationMs\":10}]}]}");

        assertThat(importFile(file).imported()).isEqualTo(1);
    }

    @Test
    void aRuleWhoseAnswerRefIsNotInTheFileIsRejectedOnItsOwn() throws Exception {
        JsonNode file = mapper.readTree("{\"alfredInterceptionRules\":2,\"rules\":["
                + "{\"name\":\"Orphan\",\"match\":{},\"actions\":[{\"type\":\"ANSWER_WITH_RECORDED_CALL\",\"answerRef\":\"a9\"}]},"
                + "{\"name\":\"Slow\",\"match\":{},\"actions\":[{\"type\":\"DELAY_REQUEST\",\"durationMs\":10}]}],\"answers\":[]}");

        RuleImportResult result = importFile(file);

        assertThat(result.imported()).isEqualTo(1);
        assertThat(result.rejected()).isEqualTo(1);
    }
}
