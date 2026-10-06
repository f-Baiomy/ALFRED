package com.fathy.alfred.backend.investigationbridge;

import com.fathy.alfred.backend.dbcapture.application.port.in.ManageDbCaptureUseCase;
import com.fathy.alfred.backend.dbcapture.domain.model.ProjectCaptureStatus;
import com.fathy.alfred.backend.internalcalls.domain.model.CallSummary;
import com.fathy.alfred.backend.investigationbridge.InvestigationModels.CycleRef;
import com.fathy.alfred.backend.investigationbridge.InvestigationModels.ResolvedScope;
import com.fathy.alfred.backend.investigationbridge.InvestigationModels.ScopeCall;
import com.fathy.alfred.backend.investigationbridge.InvestigationModels.ScopeDto;
import com.fathy.alfred.backend.investigationbridge.InvestigationModels.ScopeInfo;
import com.fathy.alfred.backend.investigationbridge.InvestigationModels.Unavailable;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListPagedCapturedInternalCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListSessionCyclesUseCase;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import com.fathy.alfred.backend.triagebridge.CycleCallsReader;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Set;

/**
 * Turns a scope - the live calls, some cycles, or everything - into its inbound calls, each once, with where it is held
 * (specs/010-mcp-log-investigation, research R5). A call can be live and in several cycles under one id (a cycle's
 * copy keeps it), so counting by id counts it once. Inbound calls only: database and log signals belong to them, and a
 * supplier call's failure is counted on the inbound call that made it.
 */
@Component
public class ScopeResolver {

    private static final int PAGE = 200;

    private final com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsUseCase liveCalls;
    private final ListSessionCyclesUseCase cycles;
    private final CycleCallsReader cycleCalls;
    private final ManageDbCaptureUseCase capture;

    public ScopeResolver(com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsUseCase liveCalls, ListSessionCyclesUseCase cycles,
                         ListCapturedCallsUseCase capturedCalls, ListPagedCapturedInternalCallsUseCase capturedInternalCalls,
                         ManageDbCaptureUseCase capture) {
        this.liveCalls = liveCalls;
        this.cycles = cycles;
        this.cycleCalls = new CycleCallsReader(capturedCalls, capturedInternalCalls);
        this.capture = capture;
    }

    /**
     * @throws IllegalArgumentException for a bad scope or date
     * @throws NoSuchElementException   naming a cycle that does not exist
     */
    public ResolvedScope resolve(ScopeDto requested, String project, String from, String to) {
        ScopeDto scope = requested == null ? ScopeDto.LIVE : requested;
        Long fromMs = millis(from, "from");
        Long toMs = millis(to, "to");
        String kind = scope.kindOrLive();
        List<SessionCycle> chosen = switch (kind) {
            case "live" -> List.of();
            case "all" -> cycles.listAll();
            case "cycles" -> named(scope.cycleIds());
            default -> throw new IllegalArgumentException("scope kind must be live, cycles or all");
        };
        boolean withLive = !kind.equals("cycles") || Boolean.TRUE.equals(scope.includeLive());

        Map<String, ScopeCall> calls = new LinkedHashMap<>();
        if (withLive) {
            for (int offset = 0; ; offset += PAGE) {
                var page = liveCalls.getCalls(new com.fathy.alfred.backend.internalcalls.domain.model.CallsQuery("", "", "oldest", offset, PAGE, "", "", "", ""));
                page.calls().forEach(call -> add(calls, call, "live", project, fromMs, toMs));
                if (page.calls().isEmpty() || offset + page.calls().size() >= page.total()) {
                    break;
                }
            }
        }
        for (SessionCycle cycle : chosen) {
            cycleCalls.inbound(cycle.id(), captured -> add(calls, captured.call(), "cycle:" + cycle.name(), project, fromMs, toMs));
        }
        ScopeInfo info = new ScopeInfo(kind, chosen.stream().map(c -> new CycleRef(c.id(), c.name())).toList(), withLive, calls.size(), from, to);
        return new ResolvedScope(calls, info, unavailable(calls));
    }

    private List<SessionCycle> named(List<String> ids) {
        if (ids == null || ids.isEmpty()) {
            throw new IllegalArgumentException("scope kind cycles needs cycleIds");
        }
        if (ids.size() > InvestigationModels.MAX_CYCLES) {
            throw new IllegalArgumentException("at most " + InvestigationModels.MAX_CYCLES + " cycles per request");
        }
        Map<String, SessionCycle> byId = new LinkedHashMap<>();
        cycles.listAll().forEach(c -> byId.put(c.id(), c));
        List<SessionCycle> out = new ArrayList<>();
        for (String id : new LinkedHashSet<>(ids)) {
            SessionCycle cycle = byId.get(id);
            if (cycle == null) {
                throw new NoSuchElementException("no session cycle " + id);
            }
            out.add(cycle);
        }
        return out;
    }

    private static void add(Map<String, ScopeCall> calls, CallSummary call, String heldIn, String project, Long fromMs, Long toMs) {
        if (project != null && !project.isBlank() && !project.equals(call.serviceName())) {
            return;
        }
        long at = startMillis(call.timestamp());
        if ((fromMs != null && at < fromMs) || (toMs != null && at > toMs)) {
            return;
        }
        ScopeCall known = calls.get(call.id());
        if (known != null) {
            List<String> held = new ArrayList<>(known.heldIn());
            if (!held.contains(heldIn)) {
                held.add(heldIn);
            }
            calls.put(call.id(), new ScopeCall(known.callId(), known.method(), known.path(), known.status(), known.error(), known.startedAt(),
                    known.durationMs(), known.project(), List.copyOf(held)));
            return;
        }
        String url = call.originalUrl() != null ? call.originalUrl() : call.url();
        calls.put(call.id(), new ScopeCall(call.id(), call.method(), pathOf(url), call.status(),
                call.error(), call.timestamp(), call.durationMs(), call.serviceName(), List.of(heldIn)));
    }

    /** The URL's path and query - what a reader recognises the call by - without scheme and host. */
    private static String pathOf(String url) {
        try {
            java.net.URI uri = java.net.URI.create(url);
            return uri.getHost() == null ? url : uri.getRawPath() + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery());
        } catch (IllegalArgumentException e) {
            return url;
        }
    }

    /** Projects of the scope whose lines or statements may be missing, and why. */
    private List<Unavailable> unavailable(Map<String, ScopeCall> calls) {
        Set<String> projects = new LinkedHashSet<>();
        calls.values().forEach(c -> {
            if (c.project() != null) {
                projects.add(c.project());
            }
        });
        if (projects.isEmpty()) {
            return List.of();
        }
        List<Unavailable> out = new ArrayList<>();
        for (ProjectCaptureStatus status : capture.projects()) {
            if (!projects.contains(status.project())) {
                continue;
            }
            if (!status.logsOn()) {
                out.add(new Unavailable(status.project(), "LOGS_OFF"));
            } else if (!status.attached()) {
                out.add(new Unavailable(status.project(), "NO_AGENT"));
            }
            if (!status.enabled()) {
                out.add(new Unavailable(status.project(), "DB_OFF"));
            }
        }
        return out;
    }

    static Long millis(String iso, String name) {
        if (iso == null || iso.isBlank()) {
            return null;
        }
        try {
            return Instant.parse(iso.strip()).toEpochMilli();
        } catch (DateTimeParseException e) {
            throw new IllegalArgumentException(name + " must be an ISO-8601 instant, e.g. 2026-10-06T18:00:00Z");
        }
    }

    static long startMillis(String timestamp) {
        if (timestamp == null) {
            return 0;
        }
        try {
            return java.time.OffsetDateTime.parse(timestamp).toInstant().toEpochMilli();
        } catch (DateTimeParseException e) {
            try {
                return Instant.parse(timestamp).toEpochMilli();
            } catch (DateTimeParseException ignored) {
                return 0;
            }
        }
    }
}
