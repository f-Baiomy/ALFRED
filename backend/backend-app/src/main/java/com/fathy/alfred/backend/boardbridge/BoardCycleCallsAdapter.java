package com.fathy.alfred.backend.boardbridge;

import com.fathy.alfred.backend.board.application.port.out.CycleCallsPort;
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
public class BoardCycleCallsAdapter implements CycleCallsPort {

    private final CycleCallsReader reader;
    private final NormalizeEndpointUseCase endpoints;

    public BoardCycleCallsAdapter(ListCapturedCallsUseCase capturedCalls, ListPagedCapturedInternalCallsUseCase capturedInternalCalls,
                                  NormalizeEndpointUseCase endpoints) {
        this.reader = new CycleCallsReader(capturedCalls, capturedInternalCalls);
        this.endpoints = endpoints;
    }

    @Override
    public List<CycleCall> calls(String cycleId, int limit) {
        List<CycleCall> out = new ArrayList<>();
        try {
            reader.inbound(cycleId, c -> {
                if (out.size() < limit && c.call() != null) {
                    out.add(call("in", c.call().id(), c.call().method(), c.call().url(), c.call().status()));
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

    private CycleCall call(String direction, String id, String method, String url, Integer status) {
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
