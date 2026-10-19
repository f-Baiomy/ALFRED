package com.fathy.alfred.backend.boardbridge;

import com.fathy.alfred.backend.board.application.port.in.RelateCycleUseCase;
import org.springframework.beans.factory.ObjectProvider;

import com.fathy.alfred.backend.board.application.port.out.CycleCallsPort;
import com.fathy.alfred.backend.board.application.port.out.LiveCallsPort;
import com.fathy.alfred.backend.board.domain.model.CycleCall;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListPagedCapturedInternalCallsUseCase;
import com.fathy.alfred.backend.triage.application.port.in.NormalizeEndpointUseCase;
import com.fathy.alfred.backend.triagebridge.CycleCallsReader;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.util.ArrayList;
import java.util.List;

/**
 * A cycle's captured calls signed the way BoardCallSignatureAdapter signs a card's call ({@code 5xx|POST /api/orders/{n}}),
 * so the fix check compares like with like. Inbound first, then outbound; at most {@code limit} calls.
 */
@Component
public class BoardCycleCallsAdapter implements CycleCallsPort, LiveCallsPort {

    private final CycleCallsReader reader;
    private final NormalizeEndpointUseCase endpoints;
    private final com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsUseCase inbound;

    private final ObjectProvider<RelateCycleUseCase> relations;
    /** specs/035: a cycle another Alfred streams ({@code <id>@<slug>}) is read over its link, signed by its owner. */
    private final ObjectProvider<com.fathy.alfred.backend.linksbridge.RemoteBoardData> remote;

    public BoardCycleCallsAdapter(ListCapturedCallsUseCase capturedCalls, ListPagedCapturedInternalCallsUseCase capturedInternalCalls,
                                  NormalizeEndpointUseCase endpoints,
                                  com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsUseCase inbound,
                                  ObjectProvider<RelateCycleUseCase> relations,
                                  ObjectProvider<com.fathy.alfred.backend.linksbridge.RemoteBoardData> remote) {
        this.reader = new CycleCallsReader(capturedCalls, capturedInternalCalls);
        this.endpoints = endpoints;
        this.inbound = inbound;
        this.relations = relations;
        this.remote = remote;
    }

    /** The newest live inbound calls (the regression watch, specs/015 FR-17), signed, with their time. */
    @Override
    public List<CycleCall> recent(int limit) {
        return recentOf("", limit);
    }

    /** The newest live inbound calls of one project (its reverse-proxy service name); every project when blank. */
    @Override
    public List<CycleCall> recentOf(String project, int limit) {
        List<CycleCall> out = new ArrayList<>();
        int page = 200;
        try {
            for (int offset = 0; offset < limit; offset += page) {
                var query = new com.fathy.alfred.backend.internalcalls.domain.model.CallsQuery("", "", "newest", offset, Math.min(page, limit - offset),
                        "", "", "", project == null ? "" : project);
                var calls = inbound.getCalls(query).calls();
                for (var c : calls) {
                    CycleCall signed = call("in", c.id(), c.method(), c.url(), c.status());
                    out.add(new CycleCall(signed.direction(), signed.callId(), signed.method(), signed.path(), signed.status(), signed.signature(),
                            instant(c.timestamp()), c.durationMs()));
                }
                if (calls.size() < page) {
                    break;
                }
            }
        } catch (RuntimeException e) {
            return out; // what was read so far; the regression check never fails a request
        }
        return out;
    }

    static java.time.Instant instant(String timestamp) {
        try {
            return timestamp == null ? null : java.time.Instant.parse(timestamp);
        } catch (java.time.format.DateTimeParseException e) {
            return null;
        }
    }

    /**
     * The calls of a task (specs/027 research R1 amendment): every cycle related to the board the key names, or the cycle
     * the key itself is when it names no board. A call two cycles both captured is listed once.
     */
    /** Which streamed cycle a task's call came from ({@code task|in:<call>} -> {@code <cycle>@<slug>}), for its ref. */
    private final java.util.Map<String, String> remoteCycleOf = new java.util.concurrent.ConcurrentHashMap<>();
    private static final int REMOTE_REFS_KEPT = 100_000;

    @Override
    public java.util.Optional<String> remoteRef(String taskKey, CycleCall call) {
        String cycle = remoteCycleOf.get(taskKey + "|" + call.direction() + ":" + call.callId());
        return cycle == null ? java.util.Optional.empty() : java.util.Optional.of(call.ref(cycle));
    }

    @Override
    public List<CycleCall> calls(String taskKey, int limit) {
        List<CycleCall> out = new ArrayList<>();
        java.util.Set<String> seen = new java.util.HashSet<>();
        com.fathy.alfred.backend.linksbridge.RemoteBoardData r = remote.getIfAvailable();
        for (String cycleId : cyclesOf(taskKey)) {
            boolean streamed = r != null && r.isRemote(cycleId);
            for (CycleCall c : cycleCalls(cycleId, limit - out.size())) {
                if (seen.add(c.direction() + ":" + c.callId())) {
                    out.add(c);
                    if (streamed) {
                        if (remoteCycleOf.size() > REMOTE_REFS_KEPT) {
                            remoteCycleOf.clear();
                        }
                        remoteCycleOf.put(taskKey + "|" + c.direction() + ":" + c.callId(), cycleId);
                    }
                }
            }
            if (out.size() >= limit) {
                break;
            }
        }
        return out;
    }

    @Override
    public List<CycleCall> ofCycle(String cycleId, int limit) {
        return cycleCalls(cycleId, limit);
    }

    /** The cycles a task key stands for; the key alone when the board slice is not there to say. */
    List<String> cyclesOf(String taskKey) {
        RelateCycleUseCase r = relations.getIfAvailable();
        return r == null ? List.of(taskKey) : r.cyclesOfTask(taskKey);
    }

    private List<CycleCall> cycleCalls(String cycleId, int limit) {
        List<CycleCall> out = new ArrayList<>();
        if (limit <= 0) {
            return out;
        }
        com.fathy.alfred.backend.linksbridge.RemoteBoardData r = remote.getIfAvailable();
        if (r != null && r.isRemote(cycleId)) {
            List<CycleCall> calls = r.cycleCalls(cycleId, limit);
            return calls.size() > limit ? calls.subList(0, limit) : calls;
        }
        try {
            reader.inbound(cycleId, c -> {
                if (out.size() < limit && c.call() != null) {
                    CycleCall signed = call("in", c.call().id(), c.call().method(), c.call().url(), c.call().status());
                    out.add(new CycleCall(signed.direction(), signed.callId(), signed.method(), signed.path(), signed.status(), signed.signature(),
                            instant(c.call().timestamp()), c.call().durationMs()));
                }
            });
            reader.outbound(cycleId, c -> {
                if (out.size() < limit && c.call() != null) {
                    out.add(call("out", c.call().id(), c.call().method(), c.call().url(), c.call().status()));
                }
            });
        } catch (RuntimeException e) {
            return out; // an unreadable cycle checks what was read, never fails the request
        }
        return out;
    }

    CycleCall call(String direction, String id, String method, String url, Integer status) {
        String signature = method == null || url == null ? null : signal(status) + "|" + endpoints.endpointOf(method, url);
        return new CycleCall(direction, id, method, pathOf(url), status, signature);
    }

    static String signal(Integer status) {
        if (status == null) {
            return "error";
        }
        if (status >= 500) {
            return "5xx";
        }
        return status >= 400 ? "4xx" : "ok";
    }

    private static String pathOf(String url) {
        if (url == null) {
            return "";
        }
        try {
            String path = URI.create(url).getRawPath();
            return path == null || path.isEmpty() ? url : path;
        } catch (IllegalArgumentException e) {
            return url;
        }
    }
}
