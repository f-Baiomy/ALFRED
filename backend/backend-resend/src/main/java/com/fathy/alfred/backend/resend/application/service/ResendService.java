package com.fathy.alfred.backend.resend.application.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.resend.application.port.in.ResendCallUseCase;
import com.fathy.alfred.backend.resend.application.port.in.ResendResolutionException;
import com.fathy.alfred.backend.resend.application.port.out.CallSenderPort;
import com.fathy.alfred.backend.resend.application.port.out.CallSourcePort;
import com.fathy.alfred.backend.resend.application.port.out.GlobalVariableLookupPort;
import com.fathy.alfred.backend.resend.application.port.out.OutgoingCall;
import com.fathy.alfred.backend.resend.application.port.out.SendOutcome;
import com.fathy.alfred.backend.resend.application.port.out.SessionValueLookupPort;
import com.fathy.alfred.backend.resend.domain.model.DynamicTokens;
import com.fathy.alfred.backend.resend.domain.model.ResendBatch;
import com.fathy.alfred.backend.resend.domain.model.ResendEdits;
import com.fathy.alfred.backend.resend.domain.model.ResendRequest;
import com.fathy.alfred.backend.resend.domain.model.ResendResult;
import com.fathy.alfred.backend.resend.domain.model.SessionValue;
import com.fathy.alfred.backend.resend.domain.model.SessionValueUse;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * Resends a logged call through Alfred's own proxies. The proxy side of the link is two request
 * headers (see proxy/interception.py's take_resend_headers): {@code X-Alfred-Resend-Of} names the
 * original call, {@code X-Alfred-Resend-Edits} carries a JSON summary of what changed - names and
 * shapes only, never a header's or a session value's actual content, so a resent call's own log
 * entry never becomes a second copy of a secret. The proxy copies that summary verbatim into the
 * resent call's {@code resend_edits}, so its keys are a wire format the frontend reads:
 * <ul>
 *   <li>{@code origin: {direction, cycleId}} - always present ({@code cycleId} is JSON null for a
 *       live-logged original), so both headers are always sent;</li>
 *   <li>{@code method: {from, to}}, {@code url: {from, to}} - only when actually changed;</li>
 *   <li>{@code body: true} - when the body was replaced;</li>
 *   <li>{@code headers: [names]} - header names edited or removed;</li>
 *   <li>{@code session: [{name, fromCallId}]} - session values substituted by useCurrentSession;</li>
 *   <li>{@code batch: {id, index, total}} - only when the request was part of a batch.</li>
 * </ul>
 *
 * <p>Session headers are the two names {@code useCurrentSession} looks at - defined locally
 * rather than reusing backend-interception's {@code SensitiveHeaders} (CLAUDE.md: slices may not
 * share code).
 */
@Service
public class ResendService implements ResendCallUseCase {

    private static final java.util.regex.Pattern VARIABLE_TOKEN = java.util.regex.Pattern.compile("\\{\\{([A-Za-z][A-Za-z0-9_.-]*)\\}\\}");
    private static final String RESEND_OF_HEADER = "X-Alfred-Resend-Of";
    private static final String RESEND_EDITS_HEADER = "X-Alfred-Resend-Edits";
    private static final Set<String> SESSION_HEADER_NAMES = Set.of("cookie", "authorization");
    /** Matches the proxy's own resolution semantics and the frontend's GlobalVariablesService.resolve. */
    private static final int MAX_RESOLUTION_DEPTH = 20;
    private static final int MAX_RESOLVED_LENGTH = 10 * 1024 * 1024;

    private final CallSourcePort calls;
    private final SessionValueLookupPort sessionValues;
    private final CallSenderPort sender;
    private final GlobalVariableLookupPort variableLookup;
    private final java.time.Clock clock;
    private final ObjectMapper mapper = new ObjectMapper();

    @org.springframework.beans.factory.annotation.Autowired
    public ResendService(CallSourcePort calls, SessionValueLookupPort sessionValues, CallSenderPort sender,
                         GlobalVariableLookupPort variableLookup) {
        this(calls, sessionValues, sender, variableLookup, java.time.Clock.systemUTC());
    }

    /** Package-private: lets tests pin the clock {@code $now} dynamic tokens resolve against. */
    ResendService(CallSourcePort calls, SessionValueLookupPort sessionValues, CallSenderPort sender,
                 GlobalVariableLookupPort variableLookup, java.time.Clock clock) {
        this.calls = calls;
        this.sessionValues = sessionValues;
        this.sender = sender;
        this.variableLookup = variableLookup;
        this.clock = clock;
    }

    public ResendService(CallSourcePort calls, SessionValueLookupPort sessionValues, CallSenderPort sender) {
        this(calls, sessionValues, sender, () -> new GlobalVariableLookupPort.VariableState(Map.of(), Map.of()));
    }

    @Override
    public ResendOutcome resend(ResendRequest request) {
        Optional<com.fathy.alfred.backend.resend.domain.model.StoredCall> found =
                calls.load(request.direction(), request.callId(), request.cycleId());
        if (found.isEmpty()) {
            return new ResendOutcome.NotFound();
        }
        var original = found.get();

        Map<String, String> headers = new LinkedHashMap<>(original.headers());
        String method = original.method();
        String url = original.url();
        String body = original.body();

        Map<String, Object> editsSummary = new LinkedHashMap<>();
        Map<String, Object> origin = new LinkedHashMap<>();
        origin.put("direction", request.direction());
        origin.put("cycleId", request.cycleId());
        editsSummary.put("origin", origin);
        ResendEdits edits = request.edits();
        if (edits != null) {
            if (edits.method() != null && !edits.method().equals(method)) {
                editsSummary.put("method", Map.of("from", method, "to", edits.method()));
                method = edits.method();
            }
            if (edits.url() != null && !edits.url().equals(url)) {
                editsSummary.put("url", Map.of("from", url, "to", edits.url()));
                url = edits.url();
            }
            if (edits.body() != null) {
                body = edits.body();
                editsSummary.put("body", true);
            }
            if (edits.headers() != null && !edits.headers().isEmpty()) {
                List<String> changedNames = new ArrayList<>();
                edits.headers().forEach((name, value) -> {
                    changedNames.add(name);
                    if (value == null) {
                        removeHeaderIgnoreCase(headers, name);
                    } else {
                        putHeaderIgnoreCase(headers, name, value);
                    }
                });
                editsSummary.put("headers", changedNames);
            }
        }

        var variableState = variableLookup.current();
        java.util.function.Function<String, String> base64Lookup =
                name -> variableState.variables().getOrDefault(name, variableState.fallbacks().get(name));
        method = resolveDynamic(resolveVariables(method, variableState), base64Lookup);
        url = resolveDynamic(resolveVariables(url, variableState), base64Lookup);
        body = resolveDynamic(resolveVariables(body, variableState), base64Lookup);

        List<SessionValueUse> sessionUses = new ArrayList<>();
        if (request.useCurrentSession()) {
            List<SessionValue> newest = sessionValues.newest(
                    request.direction(), hostOf(url, original.host()), SESSION_HEADER_NAMES, request.cycleId());
            for (SessionValue value : newest) {
                putHeaderIgnoreCase(headers, value.name(), value.value());
                sessionUses.add(new SessionValueUse(value.name(), value.fromCallId()));
            }
            if (!sessionUses.isEmpty()) {
                editsSummary.put("session", sessionUses.stream()
                        .map(use -> Map.of("name", use.name(), "fromCallId", use.fromCallId()))
                        .toList());
            }
        }

        Map<String, String> resolvedHeaders = new LinkedHashMap<>();
        headers.forEach((name, value) -> resolvedHeaders.put(
                resolveDynamic(resolveVariables(name, variableState), base64Lookup),
                resolveDynamic(resolveVariables(value, variableState), base64Lookup)));
        headers.clear();
        headers.putAll(resolvedHeaders);
        ResendBatch batch = request.batch();
        if (batch != null) {
            Map<String, Object> batchSummary = new LinkedHashMap<>();
            batchSummary.put("id", batch.id());
            batchSummary.put("index", batch.index());
            batchSummary.put("total", batch.total());
            editsSummary.put("batch", batchSummary);
        }

        String newCallId = UUID.randomUUID().toString();
        putHeaderIgnoreCase(headers, "X-Request-Id", newCallId);
        putHeaderIgnoreCase(headers, RESEND_OF_HEADER, original.id());
        putHeaderIgnoreCase(headers, RESEND_EDITS_HEADER, writeJson(editsSummary));

        OutgoingCall outgoing = new OutgoingCall(
                request.direction(), method, url, headers, body, hostOf(url, original.host()), original.serviceName());

        long start = System.currentTimeMillis();
        SendOutcome outcome = sender.send(outgoing);
        long durationMs = System.currentTimeMillis() - start;

        return switch (outcome) {
            case SendOutcome.Sent sent -> new ResendOutcome.Success(new ResendResult(newCallId, sent.status(),
                    durationMs, sessionUses, new ResendResult.Response(sent.status(), sent.headers(), sent.body())));
            case SendOutcome.ReverseProxyNotRunning ignored -> new ResendOutcome.ReverseProxyNotRunning();
            case SendOutcome.Failed failed -> new ResendOutcome.SendFailed(failed.message());
        };
    }

    /**
     * Resolves {@code {{name}}} tokens recursively, matching the proxy's own semantics and the
     * frontend's {@code GlobalVariablesService.resolve}: a name already being expanded (a cycle)
     * or a depth of {@value #MAX_RESOLUTION_DEPTH} leaves the token literal, same as an unknown
     * name; a concrete variable wins over a same-named fallback; a {@code this.}-prefixed name is
     * never resolved (reserved for rule-local variables). Replaces the old fixed-20-pass,
     * whole-string replace loop, which had no cycle guard at all - a self-referencing variable
     * like {@code a="{{a}}{{a}}"} doubled in size every pass (~1M copies by pass 20), which could
     * exhaust heap well before any caller saw a response.
     */
    private static String resolveVariables(String text, GlobalVariableLookupPort.VariableState state) {
        if (text == null || text.isEmpty()) return text;
        return resolveToken(text, state, Set.of(), 0);
    }

    private static String resolveToken(String input, GlobalVariableLookupPort.VariableState state, Set<String> seen, int depth) {
        java.util.regex.Matcher matcher = VARIABLE_TOKEN.matcher(input);
        StringBuilder out = new StringBuilder();
        int last = 0;
        while (matcher.find()) {
            out.append(input, last, matcher.start());
            last = matcher.end();
            String name = matcher.group(1);
            String token = matcher.group();
            if (name.startsWith("this.") || depth >= MAX_RESOLUTION_DEPTH || seen.contains(name)) {
                out.append(token);
            } else {
                String replacement = state.variables().getOrDefault(name, state.fallbacks().get(name));
                if (replacement == null) {
                    out.append(token);
                } else {
                    Set<String> nextSeen = new java.util.HashSet<>(seen);
                    nextSeen.add(name);
                    out.append(resolveToken(replacement, state, nextSeen, depth + 1));
                }
            }
            if (out.length() > MAX_RESOLVED_LENGTH) {
                throw new ResendResolutionException("Resolved value exceeds " + MAX_RESOLVED_LENGTH + " characters.");
            }
        }
        out.append(input, last, input.length());
        if (out.length() > MAX_RESOLVED_LENGTH) {
            throw new ResendResolutionException("Resolved value exceeds " + MAX_RESOLVED_LENGTH + " characters.");
        }
        return out.toString();
    }

    /** D4: applied after global-variable resolution (see contracts.md section 2). */
    private String resolveDynamic(String text, java.util.function.Function<String, String> base64Lookup) {
        return DynamicTokens.resolve(text, base64Lookup, clock);
    }

    private static String hostOf(String url, String fallback) {
        try {
            String host = URI.create(url).getHost();
            return host != null ? host : fallback;
        } catch (RuntimeException e) {
            return fallback;
        }
    }

    private static void putHeaderIgnoreCase(Map<String, String> headers, String name, String value) {
        removeHeaderIgnoreCase(headers, name);
        headers.put(name, value);
    }

    private static void removeHeaderIgnoreCase(Map<String, String> headers, String name) {
        headers.keySet().removeIf(existing -> existing.equalsIgnoreCase(name));
    }

    private String writeJson(Object value) {
        try {
            return mapper.writeValueAsString(value);
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            return null;
        }
    }
}
