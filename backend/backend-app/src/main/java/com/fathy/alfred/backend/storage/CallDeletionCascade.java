package com.fathy.alfred.backend.storage;

import com.fathy.alfred.backend.dbcapture.application.port.in.DeleteCallStatementsUseCase;
import com.fathy.alfred.backend.triage.application.port.in.RecordCallAttentionUseCase;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.util.Collection;
import java.util.List;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * A deleted call never leaves pieces behind - fixed behaviour, not a setting. Whatever deletes an inbound call (the
 * count or size limit, the storage budget, a clean-up, "clear all", a Relive run's history), its database statements,
 * result rows, transactions, caught log lines and Redis commands go too (one transaction in db-capture.db), and its
 * triage mark. An outbound call takes its triage mark. A call a session cycle holds keeps its captures for the cycle,
 * and a Relive run's statements go with the run's history - db-capture's {@code callsDeleted} decides that.
 *
 * <p>Runs on its own thread, in the order the deletes happened: the stores report from inside their retention pass,
 * which is on the webhook's write path, and that must never wait for another database. Lives in the composition root
 * because it names four slices; none of them knows the others. The two stores report through
 * {@link InboundCallsRemoved} and {@link OutboundCallsRemoved}.
 */
@Component
public class CallDeletionCascade {

    private static final Logger log = LoggerFactory.getLogger(CallDeletionCascade.class);

    private final DeleteCallStatementsUseCase captures;
    private final RecordCallAttentionUseCase triage;
    private final Executor worker;
    /** Counts removals the storage page did not make, for its history. Optional for tests. */
    private StorageActivity activity;

    @Autowired(required = false)
    void setActivity(StorageActivity activity) {
        this.activity = activity;
    }

    /** The agent sends a call's statements in batches that can arrive after the call is gone: asked again later. */
    static final long LATE_PASS_SECONDS = 60;
    private java.util.concurrent.ScheduledExecutorService latePass;

    @Autowired
    public CallDeletionCascade(DeleteCallStatementsUseCase captures, RecordCallAttentionUseCase triage) {
        this(captures, triage, Executors.newSingleThreadScheduledExecutor(r -> {
            Thread thread = new Thread(r, "call-deletion-cascade");
            thread.setDaemon(true);
            return thread;
        }));
        this.latePass = (java.util.concurrent.ScheduledExecutorService) worker;
    }

    CallDeletionCascade(DeleteCallStatementsUseCase captures, RecordCallAttentionUseCase triage, Executor worker) {
        this.captures = captures;
        this.triage = triage;
        this.worker = worker;
    }

    void inboundRemoved(Collection<String> callIds) {
        if (callIds == null || callIds.isEmpty()) {
            return;
        }
        if (activity != null) {
            activity.removed(true, callIds.size());
        }
        List<String> ids = List.copyOf(callIds);
        worker.execute(() -> {
            try {
                captures.callsDeleted(ids);
            } catch (RuntimeException e) {
                log.warn("Deleting the captured data of {} deleted inbound calls failed", ids.size(), e);
            }
            triage.callsDeleted(ids);
        });
        if (latePass != null) {
            latePass.schedule(() -> {
                try {
                    captures.callsDeleted(ids);
                } catch (RuntimeException e) {
                    log.debug("Late pass over {} deleted calls failed: {}", ids.size(), e.getMessage());
                }
            }, LATE_PASS_SECONDS, java.util.concurrent.TimeUnit.SECONDS);
        }
    }

    void outboundRemoved(Collection<String> callIds) {
        if (callIds == null || callIds.isEmpty()) {
            return;
        }
        if (activity != null) {
            activity.removed(false, callIds.size());
        }
        List<String> ids = List.copyOf(callIds);
        worker.execute(() -> triage.callsDeleted(ids));
    }

    @PreDestroy
    void stop() {
        if (worker instanceof ExecutorService service) {
            service.shutdown();
        }
    }

    /** The inbound store's side. */
    @Component
    static class InboundCallsRemoved implements com.fathy.alfred.backend.internalcalls.application.port.out.InternalCallsRemovedPort {
        private final CallDeletionCascade cascade;

        InboundCallsRemoved(CallDeletionCascade cascade) {
            this.cascade = cascade;
        }

        @Override
        public void callsRemoved(Collection<String> callIds) {
            cascade.inboundRemoved(callIds);
        }

    }

    /** The outbound store's side. */
    @Component
    static class OutboundCallsRemoved implements com.fathy.alfred.backend.calls.application.port.out.CallsRemovedPort {
        private final CallDeletionCascade cascade;

        OutboundCallsRemoved(CallDeletionCascade cascade) {
            this.cascade = cascade;
        }

        @Override
        public void callsRemoved(Collection<String> callIds) {
            cascade.outboundRemoved(callIds);
        }

    }
}
