package com.fathy.alfred.backend.linksbridge;

import com.fathy.alfred.backend.board.application.port.in.ManageBoardsUseCase;
import com.fathy.alfred.backend.links.application.port.in.StreamsUseCase;
import com.fathy.alfred.backend.links.domain.model.Stream;
import com.fathy.alfred.backend.links.domain.model.StreamKind;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetSessionCycleUseCase;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Keeps the names readers see current: a streamed cycle or board renamed here is renamed on the reader too (their copy of
 * the stream holds names only). Runs a moment after a cycles or boards signal, once for a burst of them.
 */
@Component
public class StreamNames {

    private final ObjectProvider<StreamsUseCase> streams;
    private final ObjectProvider<GetSessionCycleUseCase> cycles;
    private final ObjectProvider<ManageBoardsUseCase> boards;
    private final AtomicBoolean pending = new AtomicBoolean();
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "link-stream-names");
        t.setDaemon(true);
        return t;
    });

    public StreamNames(ObjectProvider<StreamsUseCase> streams, ObjectProvider<GetSessionCycleUseCase> cycles,
                       ObjectProvider<ManageBoardsUseCase> boards) {
        this.streams = streams;
        this.cycles = cycles;
        this.boards = boards;
    }

    @PreDestroy
    void stop() {
        timer.shutdownNow();
    }

    void changed() {
        if (pending.compareAndSet(false, true)) {
            timer.schedule(() -> {
                pending.set(false);
                refresh();
            }, 1, TimeUnit.SECONDS);
        }
    }

    void refresh() {
        StreamsUseCase s = streams.getIfAvailable();
        if (s == null) {
            return;
        }
        for (Stream st : s.streams(true, null, null, null, false)) {
            try {
                if (st.kind() == StreamKind.CYCLE) {
                    GetSessionCycleUseCase g = cycles.getIfAvailable();
                    if (g != null) {
                        g.getById(st.target()).ifPresent(c -> s.renamed(StreamKind.CYCLE, st.target(), c.name(), c.assignedTo()));
                    }
                } else {
                    ManageBoardsUseCase b = boards.getIfAvailable();
                    if (b != null && !st.target().startsWith("default:")) {
                        b.get(st.target()).ifPresent(x -> s.renamed(StreamKind.BOARD, st.target(), x.board().name(), x.board().project()));
                    }
                }
            } catch (RuntimeException ignored) {
                // a name that cannot be read stays as it was
            }
        }
    }
}
