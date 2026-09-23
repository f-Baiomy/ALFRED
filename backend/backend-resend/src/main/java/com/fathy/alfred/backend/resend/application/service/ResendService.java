package com.fathy.alfred.backend.resend.application.service;

import com.fathy.alfred.backend.resend.application.port.in.ResendCallUseCase;
import com.fathy.alfred.backend.resend.application.port.out.CallSenderPort;
import com.fathy.alfred.backend.resend.application.port.out.CallSourcePort;
import com.fathy.alfred.backend.resend.application.port.out.SessionValueLookupPort;
import com.fathy.alfred.backend.resend.domain.model.OutgoingCall;
import com.fathy.alfred.backend.resend.domain.model.ResendEdits;
import com.fathy.alfred.backend.resend.domain.model.ResendRequest;
import com.fathy.alfred.backend.resend.domain.model.ResendResult;
import com.fathy.alfred.backend.resend.domain.model.SendOutcome;
import com.fathy.alfred.backend.resend.domain.model.SessionValue;
import com.fathy.alfred.backend.resend.domain.model.SessionValueUse;
import com.fathy.alfred.backend.resend.domain.model.StoredCall;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.UUID;

@Service
public class ResendService implements ResendCallUseCase {

    /** The session-carrying names. The full secret list lives in backend-interception's
     * SensitiveHeaders; slices may not share code, so only the two a session needs are here. */
    private static final Set<String> SESSION_HEADERS = Set.of("authorization", "cookie");

    private static final Set<String> DROPPED_HEADERS = Set.of(
            "content-length", "host", "connection", "transfer-encoding", "keep-alive", "upgrade",
            "expect", "x-alfred-resend-of", "x-alfred-resend-edits");

    private final CallSourcePort callSourcePort;
    private final SessionValueLookupPort sessionValueLookupPort;
    private final CallSenderPort callSenderPort;
    private final ObjectMapper mapper = new ObjectMapper();

    public ResendService(CallSourcePort callSourcePort, SessionValueLookupPort sessionValueLookupPort,
                          CallSenderPort callSenderPort) {
        this.callSourcePort = callSourcePort;
        this.sessionValueLookupPort = sessionValueLookupPort;
        this.callSenderPort = callSenderPort;
    }

    @Override
    public ResendOutcome resend(ResendRequest request) {
        Optional<StoredCall> found = callSourcePort.load(request.direction(), request.callId(), request.cycleId());
        if (found.isEmpty()) {
            return new ResendOutcome.NotFound();
        }
        StoredCall call = found.get();

        Map<String, String> headers = new TreeMap<>(String.CASE_INSENSITIVE_ORDER);
        headers.putAll(call.headers());
        for (String dropped : DROPPED_HEADERS) {
            headers.remove(dropped);
        }

        ResendEdits edits = request.edits();
        Map<String, Object> editsLog = new LinkedHashMap<>();

        String method = call.method();
        if (edits.method() != null && !edits.method().isBlank()
                && !edits.method().equalsIgnoreCase(call.method())) {
            String newMethod = edits.method().toUpperCase();
            editsLog.put("method", Map.of("from", call.method(), "to", newMethod));
            method = newMethod;
        }

        String url = call.originalUrl();
        if (edits.url() != null && !edits.url().isBlank() && !edits.url().equals(call.originalUrl())) {
            editsLog.put("url", Map.of("from", call.originalUrl(), "to", edits.url()));
            url = edits.url();
        }

        Set<String> editedHeaderNames = new TreeSet<>();
        for (Map.Entry<String, String> entry : edits.headers().entrySet()) {
            String name = entry.getKey();
            String value = entry.getValue();
            if (value == null) {
                headers.remove(name);
            } else {
                headers.remove(name);
                headers.put(name, value);
            }
            editedHeaderNames.add(name.toLowerCase());
        }
        if (!editedHeaderNames.isEmpty()) {
            editsLog.put("headers", new ArrayList<>(editedHeaderNames));
        }

        String body = call.body();
        if (edits.body() != null && !edits.body().equals(call.body())) {
            editsLog.put("body", true);
            body = edits.body();
        }

        List<SessionValueUse> sessionValuesUsed = new ArrayList<>();
        if (request.useCurrentSession()) {
            String authority;
            try {
                authority = URI.create(url).getRawAuthority();
                if (authority == null) {
                    throw new IllegalArgumentException();
                }
                authority = authority.toLowerCase();
            } catch (Exception e) {
                return new ResendOutcome.SendFailed("That URL is not valid.");
            }
            List<SessionValue> values = sessionValueLookupPort.newest(
                    request.direction(), authority, SESSION_HEADERS, call.id());
            List<Map<String, String>> sessionLog = new ArrayList<>();
            for (SessionValue value : values) {
                if (editedHeaderNames.contains(value.name().toLowerCase())) {
                    continue;
                }
                headers.remove(value.name());
                headers.put(value.name(), value.value());
                sessionValuesUsed.add(new SessionValueUse(value.name(), value.fromCallId()));
                sessionLog.add(Map.of("name", value.name(), "fromCallId", value.fromCallId()));
            }
            if (!sessionLog.isEmpty()) {
                editsLog.put("session", sessionLog);
            }
        }

        String newId = UUID.randomUUID().toString();
        headers.put("X-Request-Id", newId);
        headers.put("X-Alfred-Resend-Of", call.id());
        if (!editsLog.isEmpty()) {
            try {
                headers.put("X-Alfred-Resend-Edits", mapper.writeValueAsString(editsLog));
            } catch (Exception e) {
                return new ResendOutcome.SendFailed("Could not encode resend edits.");
            }
        }

        OutgoingCall outgoing = new OutgoingCall(request.direction(), method, url, headers, body, call.serviceName());
        SendOutcome outcome = callSenderPort.send(outgoing);
        return switch (outcome) {
            case SendOutcome.Sent sent -> new ResendOutcome.Done(
                    new ResendResult(newId, sent.status(), sent.durationMs(), sessionValuesUsed));
            case SendOutcome.ReverseProxyNotRunning ignored -> new ResendOutcome.ReverseProxyNotRunning();
            case SendOutcome.Failed failed -> new ResendOutcome.SendFailed(failed.message());
        };
    }
}
