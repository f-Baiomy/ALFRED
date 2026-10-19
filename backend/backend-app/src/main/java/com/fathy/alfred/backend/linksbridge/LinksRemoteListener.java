package com.fathy.alfred.backend.linksbridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.application.port.in.ManageBoardsUseCase;
import com.fathy.alfred.backend.board.application.port.in.RelateCycleUseCase;
import com.fathy.alfred.backend.board.application.port.in.RequirementWatchUseCase;
import com.fathy.alfred.backend.board.domain.model.CycleCall;
import com.fathy.alfred.backend.links.application.port.out.RemoteListenerPort;
import com.fathy.alfred.backend.links.domain.model.Link;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * The host works a streamed-in cycle as if it were its own (D25): when the owner signals that the cycle got calls, the
 * boards it is on judge their requirements on them - by the endpoints the new calls hit, through the same requirement
 * watch a local call goes through. Signals of one cycle within two seconds are judged once.
 */
@Component
public class LinksRemoteListener implements RemoteListenerPort {

    static final long COALESCE_MS = 2_000;
    static final int NEWEST = 200;

    private final ObjectProvider<RelateCycleUseCase> relations;
    private final ObjectProvider<ManageBoardsUseCase> boards;
    private final ObjectProvider<RequirementWatchUseCase> watch;
    private final RemoteBoardData remote;
    private final ObjectMapper json = new ObjectMapper();
    private final Set<String> waiting = ConcurrentHashMap.newKeySet();
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "link-remote-judge");
        t.setDaemon(true);
        return t;
    });

    public LinksRemoteListener(ObjectProvider<RelateCycleUseCase> relations, ObjectProvider<ManageBoardsUseCase> boards,
                               ObjectProvider<RequirementWatchUseCase> watch, RemoteBoardData remote) {
        this.relations = relations;
        this.boards = boards;
        this.watch = watch;
        this.remote = remote;
    }

    @PreDestroy
    void stop() {
        timer.shutdownNow();
    }

    @Override
    public void signal(Link link, String channel, String data) {
        if (!"session-cycles".equals(channel)) {
            return;
        }
        String cycleId;
        try {
            JsonNode m = json.readTree(data);
            cycleId = m.hasNonNull("cycleId") ? m.path("cycleId").asText() : null;
        } catch (Exception e) {
            return;
        }
        if (cycleId == null) {
            return;
        }
        String ref = cycleId + "@" + link.slug();
        if (waiting.add(ref)) {
            timer.schedule(() -> {
                waiting.remove(ref);
                judge(ref);
            }, COALESCE_MS, TimeUnit.MILLISECONDS);
        }
    }

    void judge(String cycleRef) {
        RelateCycleUseCase r = relations.getIfAvailable();
        RequirementWatchUseCase w = watch.getIfAvailable();
        ManageBoardsUseCase b = boards.getIfAvailable();
        if (r == null || w == null) {
            return;
        }
        List<String> onBoards = r.boardsOfCycle(cycleRef);
        if (onBoards.isEmpty()) {
            return;
        }
        Set<String> endpoints = new LinkedHashSet<>();
        List<CycleCall> calls = remote.cycleCalls(cycleRef, NEWEST);
        int from = Math.max(0, calls.size() - NEWEST);
        for (CycleCall c : calls.subList(from, calls.size())) {
            String e = c.endpoint();
            if (e != null && !e.isBlank()) {
                endpoints.add(e);
            }
        }
        Set<String> projects = new LinkedHashSet<>();
        remote.project(cycleRef).ifPresent(projects::add);
        for (String board : onBoards) {
            if (board.startsWith("default:")) {
                projects.add(board.substring("default:".length()));
            } else if (b != null) {
                b.get(board).ifPresent(s -> projects.add(s.board().project()));
            }
        }
        for (String project : projects) {
            for (String endpoint : endpoints) {
                try {
                    w.callArrived(project, endpoint);
                } catch (RuntimeException ignored) {
                    // the watch never fails a signal
                }
            }
        }
    }
}
