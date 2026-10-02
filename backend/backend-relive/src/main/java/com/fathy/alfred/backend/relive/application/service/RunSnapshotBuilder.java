package com.fathy.alfred.backend.relive.application.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fathy.alfred.backend.relive.application.port.out.RunSnapshotPublisherPort;
import com.fathy.alfred.backend.relive.domain.model.CycleRule;
import com.fathy.alfred.backend.relive.domain.model.FrozenCall;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;
import com.fathy.alfred.backend.relive.domain.model.Run;
import com.fathy.alfred.backend.relive.domain.model.RunStatus;
import com.fathy.alfred.backend.relive.domain.model.Step;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Turns a run's {@code definition} into the proxy snapshot JSON of
 * {@code contracts/proxy-snapshot.md} (research D17). This is the entire backend→proxy channel
 * for a run - the addons never call back into the backend on the request path.
 *
 * <p><b>The recorded-request answer file (FR-014d, C3 fix).</b> A cycle's own definition names the
 * recording a {@code MATCHES_RECORDED_CALL} condition compares against by {@code recordedStepKey}
 * (a step in the same cycle) - never by an {@code answerId}, because a cycle has no run yet and so
 * nothing to number. This builder is the one place that gap closes: for every such condition it
 * writes the named step's recorded request as a stored answer under
 * {@code relive/answers/<runId>/<answerId>.{meta.json,body}} and replaces {@code recordedStepKey}
 * with the new {@code answerId} in the snapshot (never in the stored cycle definition itself). A
 * snapshot that still had {@code recordedStepKey} would make every REPLAY child's request count as
 * "differs" from the proxy's point of view, since it has no cycle to resolve a step key against.
 *
 * <p>Oversized mock bodies (T033's other answer-file case) are not yet moved out of line by this
 * builder - every {@code MOCK_RESPONSE}/{@code REPLACE_RESPONSE} body is still written inline in
 * the snapshot. No size limit for one exists elsewhere in the codebase to mirror yet; revisit once
 * real mock bodies are seen to need it.
 */
@Component
public class RunSnapshotBuilder {

    private static final int SNAPSHOT_VERSION = 1;

    /** A mock body above this is written as a stored answer and referenced, not inlined: the proxy
     *  parses the whole snapshot on every republish, on the event loop that carries all traffic. */
    static final int INLINE_BODY_LIMIT = 64 * 1024;

    private final RunSnapshotPublisherPort publisher;
    private final ObjectMapper objectMapper;

    public RunSnapshotBuilder(RunSnapshotPublisherPort publisher, ObjectMapper objectMapper) {
        this.publisher = publisher;
        this.objectMapper = objectMapper;
    }

    /** Every distinct {@code serviceName} among a cycle's top-level and child steps - the same set
     *  this builder writes to the snapshot's {@code projects} array, reused by {@link CycleValidator}
     *  (T077's GUIDED_PROJECT_BUSY) to tell whether two cycles could ever contend for the same
     *  inbound project without needing a run to exist first. */
    public static Set<String> projectsOf(ReliveCycle cycle) {
        Set<String> projects = new LinkedHashSet<>();
        if (cycle.steps() == null) {
            return projects;
        }
        for (Step step : cycle.steps()) {
            if (step.serviceName() != null) {
                projects.add(step.serviceName());
            }
        }
        return projects;
    }

    public ObjectNode build(Run run) {
        ReliveCycle definition = run.definition();
        ObjectNode snapshot = objectMapper.createObjectNode();
        snapshot.put("version", SNAPSHOT_VERSION);
        snapshot.put("state", run.status() == RunStatus.RUNNING ? "RUNNING" : "STOPPING");
        snapshot.put("runId", run.id());
        snapshot.put("cycleId", run.cycleId());
        snapshot.put("driver", run.driver());

        ObjectNode globalRules = snapshot.putObject("globalRules");
        globalRules.put("mode", definition.globalRules().mode());
        ArrayNode selectedIds = globalRules.putArray("selectedIds");
        definition.globalRules().selectedIds().forEach(selectedIds::add);

        Set<String> projects = new LinkedHashSet<>();
        Map<String, String> variables = new LinkedHashMap<>();
        List<String> secrets = new ArrayList<>();
        definition.variables().forEach(v -> {
            variables.put(v.name(), v.value());
            if (v.secret()) {
                secrets.add(v.name());
            }
        });
        run.variableTimeline().forEach(change -> variables.put(change.name(), change.value()));
        ObjectNode variablesNode = snapshot.putObject("variables");
        variables.forEach(variablesNode::put);
        ArrayNode secretsNode = snapshot.putArray("secrets");
        secrets.forEach(secretsNode::add);

        List<Step> tops = definition.steps().stream().filter(s -> s.parentKey() == null).toList();
        Map<String, Map<String, List<String>>> fingerprintIndex = definition.fingerprintIndex();
        ArrayNode stepsNode = snapshot.putArray("steps");
        Map<String, Map<String, Integer>> ordinalCounters = new LinkedHashMap<>();
        for (Step top : tops) {
            if (top.serviceName() != null) {
                projects.add(top.serviceName());
            }
            ObjectNode stepNode = stepsNode.addObject();
            stepNode.put("stepKey", top.key());
            stepNode.put("direction", top.direction());
            stepNode.put("serviceName", top.serviceName());
            stepNode.put("enabled", top.enabled());
            // A Guided run has no header to name the step, so the reverse proxy matches an arriving
            // inbound call to the next expected step by this endpoint.
            if (top.recording() != null) {
                ObjectNode recorded = stepNode.putObject("recordedRequest");
                recorded.put("method", top.recording().method());
                putUrl(recorded, safeUri(top.recording().url()), top.recording().url());
            }
            JsonNode topRule = top.callRule() == null ? null : top.callRule().rule();
            stepNode.put("mode", modeOf(topRule));
            stepNode.set("callRule", outlineLargeMocks(run.id(), top.key(), resolveRecordedCallConditions(run.id(), topRule, top)));
            ArrayNode childrenNode = stepNode.putArray("children");
            Map<String, Integer> counters = ordinalCounters.computeIfAbsent(top.key(), k -> new LinkedHashMap<>());
            appendChildren(childrenNode, top.key(), definition.steps(), run.id(), counters, projects, fingerprintIndex);
            putFingerprintIndex(stepNode, top.key(), fingerprintIndex);
        }
        ArrayNode projectsNode = snapshot.putArray("projects");
        projects.forEach(projectsNode::add);

        ArrayNode cycleRulesNode = snapshot.putArray("cycleRules");
        for (CycleRule rule : definition.cycleRules()) {
            cycleRulesNode.add(rule.rule());
        }

        ObjectNode unexpectedNode = snapshot.putObject("unexpectedCalls");
        unexpectedNode.put("policy", definition.unexpectedCalls().policy());
        ArrayNode unexpectedRulesNode = unexpectedNode.putArray("rules");
        definition.unexpectedCalls().rules().forEach(r -> unexpectedRulesNode.add(r.rule()));
        unexpectedNode.put("fallback", definition.unexpectedCalls().fallback());

        return snapshot;
    }

    private void appendChildren(ArrayNode childrenNode, String parentKey, List<Step> all, String runId,
                                 Map<String, Integer> counters, Set<String> projects,
                                 Map<String, Map<String, List<String>>> fingerprintIndex) {
        for (Step child : all) {
            if (!parentKey.equals(child.parentKey())) {
                continue;
            }
            if (child.serviceName() != null) {
                projects.add(child.serviceName());
            }
            childrenNode.add(buildChild(runId, child, counters, all, projects, fingerprintIndex));
        }
    }

    private ObjectNode buildChild(String runId, Step child, Map<String, Integer> counters, List<Step> all,
                                   Set<String> projects, Map<String, Map<String, List<String>>> fingerprintIndex) {
        ObjectNode node = objectMapper.createObjectNode();
        node.put("stepKey", child.key());
        node.put("direction", child.direction());
        node.put("enabled", child.enabled());

        String matchKey = matchKeyOf(child.recording());
        int ordinal = counters.merge(matchKey, 1, Integer::sum);
        node.put("ordinal", ordinal);

        JsonNode ruleDoc = child.callRule() == null ? null : child.callRule().rule();
        JsonNode match = ruleDoc == null ? null : ruleDoc.get("match");
        node.set("match", hasCustomMatch(match) ? match : defaultMatch(child.recording()));

        // The mode the call rule gives (REPLAY / LIVE_MOCKED / LIVE): what the proxy logs as the
        // call's choice, and what keeps the REPLAY guard on when a large mock is moved to a file.
        node.put("mode", modeOf(ruleDoc));
        JsonNode resolvedRule = outlineLargeMocks(runId, child.key(), resolveRecordedCallConditions(runId, ruleDoc, child));
        node.set("callRule", resolvedRule);
        node.put("unattributed", child.unattributed());
        if (child.fingerprint() != null && child.fingerprintVersion() != null) {
            node.put("fingerprint", child.fingerprint());
            node.put("fingerprintVersion", child.fingerprintVersion());
        }

        ObjectNode recordedRequest = node.putObject("recordedRequest");
        FrozenCall recording = child.recording();
        recordedRequest.put("method", recording.method());
        URI uri = safeUri(recording.url());
        putUrl(recordedRequest, uri, recording.url());

        ArrayNode nested = node.putArray("children");
        appendChildren(nested, child.key(), all, runId, new LinkedHashMap<>(), projects, fingerprintIndex);
        putFingerprintIndex(node, child.key(), fingerprintIndex);
        return node;
    }

    /** The in-flight step looks its live hash up here. Absent when this step has no SEMANTIC_V1 candidates. */
    private void putFingerprintIndex(ObjectNode node, String stepKey, Map<String, Map<String, List<String>>> index) {
        Map<String, List<String>> forStep = index == null ? null : index.get(stepKey);
        if (forStep == null || forStep.isEmpty()) {
            return;
        }
        ObjectNode indexNode = node.putObject("fingerprintIndex");
        for (Map.Entry<String, List<String>> entry : forStep.entrySet()) {
            ArrayNode keys = indexNode.putArray(entry.getKey());
            entry.getValue().forEach(keys::add);
        }
    }

    private static void putUrl(ObjectNode target, URI uri, String rawUrl) {
        if (uri != null && uri.getScheme() != null) {
            target.put("scheme", uri.getScheme());
        }
        if (uri != null && uri.getHost() != null) {
            target.put("host", uri.getHost());
        }
        target.put("path", uri == null ? rawUrl : uri.getPath());
        target.put("query", uri == null || uri.getQuery() == null ? "" : uri.getQuery());
    }

    private static boolean hasCustomMatch(JsonNode match) {
        if (match == null || match.isNull() || !match.isObject()) {
            return false;
        }
        return match.has("host") || match.has("pathRegex") || match.has("pathContains")
                || (match.has("methods") && match.get("methods").size() > 0);
    }

    private ObjectNode defaultMatch(FrozenCall recording) {
        ObjectNode match = objectMapper.createObjectNode();
        String source = recording.source() == null || recording.source().isBlank() ? "outbound" : recording.source();
        match.put("source", source);
        ArrayNode methods = match.putArray("methods");
        methods.add(recording.method());
        URI uri = safeUri(recording.url());
        if (uri != null && uri.getHost() != null) {
            match.put("host", uri.getHost());
        }
        String path = uri == null ? recording.url() : uri.getPath();
        match.put("pathRegex", "^" + pythonRegexQuote(path == null ? "" : path) + "$");
        return match;
    }

    /**
     * The snapshot is evaluated by the Python proxy, so its regex must use Python-compatible
     * escaping. Java's {@code Pattern.quote} writes {@code \Q...\E}, which Python rejects and
     * would make a replay child silently fail to match.
     */
    private static String pythonRegexQuote(String value) {
        StringBuilder escaped = new StringBuilder(value.length());
        for (int i = 0; i < value.length(); i++) {
            char character = value.charAt(i);
            if ("\\\\.^$|?*+()[]{}".indexOf(character) >= 0) {
                escaped.append('\\');
            }
            escaped.append(character);
        }
        return escaped.toString();
    }

    private static String matchKeyOf(FrozenCall recording) {
        URI uri = safeUri(recording.url());
        String host = uri == null ? "" : String.valueOf(uri.getHost());
        String path = uri == null ? recording.url() : uri.getPath();
        return recording.method() + " " + host + path;
    }

    private static URI safeUri(String url) {
        try {
            return URI.create(url);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /**
     * Deep-copies {@code ruleDoc}, replacing every {@code recordedStepKey} on a RECORDED_CALL
     * condition with a freshly written {@code answerId} pointing at that step's recorded request
     * (C3). Walks every {@code IF_REQUEST}/{@code IF_RESPONSE} action's {@code branches[].conditions}
     * recursively (conditions never nest inside conditions any deeper than one branch's own list).
     */
    private JsonNode resolveRecordedCallConditions(String runId, JsonNode ruleDoc, Step owner) {
        if (ruleDoc == null || ruleDoc.isNull()) {
            return ruleDoc;
        }
        JsonNode copy = ruleDoc.deepCopy();
        JsonNode actions = copy.get("actions");
        if (actions != null && actions.isArray()) {
            resolveActions((ArrayNode) actions, runId, owner);
        }
        return copy;
    }

    private void resolveActions(ArrayNode actions, String runId, Step owner) {
        for (JsonNode actionNode : actions) {
            if (!(actionNode instanceof ObjectNode action)) {
                continue;
            }
            for (String branchesField : new String[] {"branches"}) {
                JsonNode branches = action.get(branchesField);
                if (branches != null && branches.isArray()) {
                    for (JsonNode branch : branches) {
                        JsonNode conditions = branch.get("conditions");
                        if (conditions != null && conditions.isArray()) {
                            resolveConditions((ArrayNode) conditions, runId, owner);
                        }
                        JsonNode nestedActions = branch.get("actions");
                        if (nestedActions != null && nestedActions.isArray()) {
                            resolveActions((ArrayNode) nestedActions, runId, owner);
                        }
                    }
                }
            }
            JsonNode otherwise = action.get("otherwise");
            if (otherwise != null && otherwise.isArray()) {
                resolveActions((ArrayNode) otherwise, runId, owner);
            }
        }
    }

    private void resolveConditions(ArrayNode conditions, String runId, Step owner) {
        for (JsonNode conditionNode : conditions) {
            if (!(conditionNode instanceof ObjectNode condition)) {
                continue;
            }
            if (!"RECORDED_CALL".equals(textOrNull(condition, "subject"))) {
                continue;
            }
            String recordedStepKey = textOrNull(condition, "recordedStepKey");
            if (recordedStepKey == null) {
                continue; // already an answerId (e.g. a re-published run) - nothing to do
            }
            String answerId = writeRecordedRequestAnswer(runId, recordedStepKey, owner);
            condition.remove("recordedStepKey");
            condition.put("answerId", answerId);
        }
    }

    private String writeRecordedRequestAnswer(String runId, String recordedStepKey, Step owner) {
        // The condition's own step owns its recording in every case this builder ever sees today
        // (a call rule's request-differs condition always compares against its own step's
        // recording) - recordedStepKey is still carried explicitly in the definition so a future
        // condition could name a DIFFERENT step's recording without a format change here.
        FrozenCall recording = owner.recording();
        // Named by the run, the step and the recorded request itself: every republish of the run
        // (a variable, an edit, stopping) names the same file, which is written once, instead of a
        // new copy of every recorded body each time (review P3).
        String answerId = UUID.nameUUIDFromBytes((runId + "|" + owner.key() + "|" + recording.method() + " "
                + recording.url() + "|" + recording.requestHeaders() + "|" + recording.requestBody())
                .getBytes(StandardCharsets.UTF_8)).toString();
        ObjectNode meta = objectMapper.createObjectNode();
        meta.put("kind", "RECORDED_REQUEST");
        meta.put("method", recording.method());
        URI uri = safeUri(recording.url());
        putUrl(meta, uri, recording.url());
        ObjectNode headers = meta.putObject("headers");
        recording.requestHeaders().forEach(headers::put);
        byte[] body = recording.requestBody() == null ? new byte[0] : recording.requestBody().getBytes(StandardCharsets.UTF_8);
        publisher.writeAnswer(runId, answerId, meta, body);
        return answerId;
    }

    /** REPLAY when an enabled MOCK_RESPONSE answers, LIVE_MOCKED when an enabled REPLACE_RESPONSE
     *  replies, LIVE otherwise - the frontend's modeOf over the same top-level actions. */
    static String modeOf(JsonNode ruleDoc) {
        JsonNode actions = ruleDoc == null ? null : ruleDoc.get("actions");
        if (actions == null || !actions.isArray()) {
            return "LIVE";
        }
        boolean replace = false;
        for (JsonNode action : actions) {
            if (action.path("enabled").isBoolean() && !action.path("enabled").asBoolean()) {
                continue;
            }
            String type = action.path("type").asText();
            if ("MOCK_RESPONSE".equals(type)) {
                return "REPLAY";
            }
            replace |= "REPLACE_RESPONSE".equals(type);
        }
        return replace ? "LIVE_MOCKED" : "LIVE";
    }

    /** Replaces each MOCK_RESPONSE whose body is over INLINE_BODY_LIMIT with an ANSWER_WITH_FILE of
     *  the same answer, written once under the run's answers directory (T033, review P6). */
    private JsonNode outlineLargeMocks(String runId, String stepKey, JsonNode ruleDoc) {
        if (ruleDoc == null || !(ruleDoc.get("actions") instanceof ArrayNode actions)) {
            return ruleDoc;
        }
        outlineActions(runId, stepKey, actions);
        return ruleDoc;
    }

    private void outlineActions(String runId, String stepKey, ArrayNode actions) {
        for (int i = 0; i < actions.size(); i++) {
            if (!(actions.get(i) instanceof ObjectNode action)) {
                continue;
            }
            for (JsonNode branch : action.path("branches")) {
                if (branch.get("actions") instanceof ArrayNode nested) {
                    outlineActions(runId, stepKey, nested);
                }
            }
            if (action.get("otherwise") instanceof ArrayNode otherwise) {
                outlineActions(runId, stepKey, otherwise);
            }
            String body = action.path("body").asText("");
            if (!"MOCK_RESPONSE".equals(action.path("type").asText()) || body.length() <= INLINE_BODY_LIMIT) {
                continue;
            }
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            String answerId = UUID.nameUUIDFromBytes((runId + "|" + stepKey + "|mock|" + body).getBytes(StandardCharsets.UTF_8)).toString();
            ObjectNode meta = objectMapper.createObjectNode();
            meta.put("id", answerId);
            meta.put("kind", "FILE");
            meta.put("status", action.path("status").asInt(200));
            meta.set("headers", action.has("headers") ? action.get("headers") : objectMapper.createObjectNode());
            publisher.writeAnswer(runId, answerId, meta, bytes);
            ObjectNode file = objectMapper.createObjectNode();
            file.put("type", "ANSWER_WITH_FILE");
            file.put("enabled", !action.path("enabled").isBoolean() || action.path("enabled").asBoolean());
            file.put("answerId", answerId);
            actions.set(i, file);
        }
    }

    private static String textOrNull(JsonNode node, String field) {
        JsonNode value = node.get(field);
        return value == null || value.isNull() ? null : value.asText();
    }
}
