package com.fathy.alfred.backend.relive.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fathy.alfred.backend.relive.application.port.in.ManageReliveCyclesUseCase;
import com.fathy.alfred.backend.relive.application.port.in.UseLiveCallAsRecordingUseCase;
import com.fathy.alfred.backend.relive.application.port.out.LiveCallStorePort;
import com.fathy.alfred.backend.relive.domain.model.CycleRule;
import com.fathy.alfred.backend.relive.domain.model.FrozenCall;
import com.fathy.alfred.backend.relive.domain.model.LiveCall;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;
import com.fathy.alfred.backend.relive.domain.model.Step;
import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.Map;

@Service
public class LiveCallsService implements UseLiveCallAsRecordingUseCase {

    private final LiveCallStorePort liveCallStore;
    private final ManageReliveCyclesUseCase manageCycles;

    public LiveCallsService(LiveCallStorePort liveCallStore, ManageReliveCyclesUseCase manageCycles) {
        this.liveCallStore = liveCallStore;
        this.manageCycles = manageCycles;
    }

    @Override
    public ReliveCycle useAsRecording(String cycleId, String liveCallId, String stepKey) {
        LiveCall live = liveCallStore.findById(liveCallId)
                .orElseThrow(() -> new IllegalArgumentException("Live call " + liveCallId + " does not exist"));
        ReliveCycle cycle = manageCycles.get(cycleId)
                .orElseThrow(() -> new IllegalArgumentException("Cycle " + cycleId + " does not exist"));
        Step step = cycle.steps().stream().filter(s -> s.key().equals(stepKey)).findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Step " + stepKey + " does not exist in cycle " + cycleId));

        Step updatedStep = withLiveCallApplied(step, live);
        java.util.List<Step> steps = cycle.steps().stream().map(s -> s.key().equals(stepKey) ? updatedStep : s).toList();
        ReliveCycle updated = new ReliveCycle(cycle.id(), cycle.name(), cycle.description(), steps, cycle.variables(),
                cycle.cycleRules(), cycle.globalRules(), cycle.settings(), cycle.noise(), cycle.unexpectedCalls(),
                cycle.createdAt(), cycle.updatedAt(), cycle.isTransient(), cycle.lastRun());
        return manageCycles.update(cycleId, updated, cycle.updatedAt(), "USE_LIVE_CALL");
    }

    /** Only {@code headers}/{@code body}/{@code status}/timing come from the live call - method,
     *  url and every other field a step's recording carries stay as they were, since a live call
     *  never records those (it answers the SAME endpoint the step already targets). */
    private static Step withLiveCallApplied(Step step, LiveCall live) {
        FrozenCall old = step.recording();
        FrozenCall recording = new FrozenCall(
                old.method(), old.url(),
                headersOf(live.request()), bodyOf(live.request()),
                live.status(),
                headersOf(live.response()), bodyOf(live.response()),
                live.at(), live.durationMs(),
                old.sessionId(), old.operationId(), old.serviceName(), old.source());
        CycleRule callRule = new CycleRule(withMockResponseUpdated(step.callRule().rule(), live), step.callRule().copiedFrom());
        return new Step(step.key(), step.parentKey(), step.label(), step.enabled(), step.optional(), step.direction(),
                step.serviceName(), callRule, step.unattributed(), recording, step.source(), step.extract(), step.assertions(), step.noise());
    }

    private static Map<String, String> headersOf(JsonNode side) {
        Map<String, String> headers = new LinkedHashMap<>();
        if (side == null || !side.has("headers")) {
            return headers;
        }
        side.get("headers").fields().forEachRemaining(e -> headers.put(e.getKey(), e.getValue().asText("")));
        return headers;
    }

    private static String bodyOf(JsonNode side) {
        if (side == null || !side.has("body") || side.get("body").isNull()) {
            return null;
        }
        return side.get("body").asText();
    }

    /** Rewrites an existing {@code MOCK_RESPONSE} action's baked-in response to match the live
     *  call, leaving everything else in the rule (match, other actions) untouched - this slice
     *  otherwise never interprets a call rule's contents (see CycleRule's own doc comment); this
     *  is a narrow, mechanical field patch, not rule evaluation. */
    private static JsonNode withMockResponseUpdated(JsonNode rule, LiveCall live) {
        if (rule == null || !rule.has("actions") || !(rule.get("actions") instanceof ArrayNode)) {
            return rule;
        }
        JsonNode copy = rule.deepCopy();
        ArrayNode actions = (ArrayNode) copy.get("actions");
        for (JsonNode action : actions) {
            if (action instanceof ObjectNode mock && "MOCK_RESPONSE".equals(mock.path("type").asText(null))) {
                JsonNode response = live.response();
                if (response != null) {
                    mock.set("status", response.path("status"));
                    mock.set("headers", response.path("headers"));
                    mock.set("body", response.path("body"));
                }
            }
        }
        return copy;
    }
}
