package com.fathy.alfred.backend.triagebridge;

import com.fathy.alfred.backend.dbcapture.application.port.in.FindStatementFailuresUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedCallDetailUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetCapturedInternalCallDetailUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListCapturedCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListPagedCapturedInternalCallsUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListSessionCyclesUseCase;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycle;
import com.fathy.alfred.backend.triage.application.port.in.RecordCallAttentionUseCase;
import com.fathy.alfred.backend.triage.domain.model.CallDirection;
import com.fathy.alfred.backend.triage.domain.model.ObservedCall;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Once, on the first start of the version that added triage: marks every call recorded before it - the live outbound
 * and inbound calls, every call a session cycle holds, and the failed-statement counts db-capture has for them - so
 * triage answers for old cycles too. Runs in the background after start-up; new calls are marked as they arrive in
 * the meantime. A marker row in triage.db makes it run only once.
 */
@Component
public class TriageBackfill {

    private static final Logger log = LoggerFactory.getLogger(TriageBackfill.class);
    /** Calls are read a day at a time, so a large outbound store is never held in memory at once. */
    private static final Duration WINDOW = Duration.ofDays(1);

    private final RecordCallAttentionUseCase record;
    private final com.fathy.alfred.backend.calls.application.port.in.GetCallsUseCase outboundCalls;
    private final com.fathy.alfred.backend.calls.application.port.in.GetCallsInRangeUseCase outboundRange;
    private final com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsUseCase inboundCalls;
    private final com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsInRangeUseCase inboundRange;
    private final ListSessionCyclesUseCase cycles;
    private final CycleCallsReader cycleCalls;
    private final GetCapturedCallDetailUseCase capturedCallDetail;
    private final GetCapturedInternalCallDetailUseCase capturedInternalCallDetail;
    private final FindStatementFailuresUseCase statementFailures;
    private final com.fathy.alfred.backend.calls.application.port.in.GetCallDetailUseCase outboundDetail;
    private final com.fathy.alfred.backend.internalcalls.application.port.in.GetCallDetailUseCase inboundDetail;

    public TriageBackfill(RecordCallAttentionUseCase record,
                          com.fathy.alfred.backend.calls.application.port.in.GetCallsUseCase outboundCalls,
                          com.fathy.alfred.backend.calls.application.port.in.GetCallsInRangeUseCase outboundRange,
                          com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsUseCase inboundCalls,
                          com.fathy.alfred.backend.internalcalls.application.port.in.GetCallsInRangeUseCase inboundRange,
                          ListSessionCyclesUseCase cycles, ListCapturedCallsUseCase capturedCalls,
                          ListPagedCapturedInternalCallsUseCase capturedInternalCalls, GetCapturedCallDetailUseCase capturedCallDetail,
                          GetCapturedInternalCallDetailUseCase capturedInternalCallDetail, FindStatementFailuresUseCase statementFailures,
                          com.fathy.alfred.backend.calls.application.port.in.GetCallDetailUseCase outboundDetail,
                          com.fathy.alfred.backend.internalcalls.application.port.in.GetCallDetailUseCase inboundDetail) {
        this.outboundDetail = outboundDetail;
        this.inboundDetail = inboundDetail;
        this.record = record;
        this.outboundCalls = outboundCalls;
        this.outboundRange = outboundRange;
        this.inboundCalls = inboundCalls;
        this.inboundRange = inboundRange;
        this.cycles = cycles;
        this.cycleCalls = new CycleCallsReader(capturedCalls, capturedInternalCalls);
        this.capturedCallDetail = capturedCallDetail;
        this.capturedInternalCallDetail = capturedInternalCallDetail;
        this.statementFailures = statementFailures;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void startInBackground() {
        if (!record.backfillNeeded()) {
            return;
        }
        Thread thread = new Thread(() -> {
            try {
                run();
            } catch (RuntimeException e) {
                // Not marked done: the next start tries again.
                log.error("triage: marking the calls recorded before this version failed", e);
            }
        }, "triage-backfill");
        thread.setDaemon(true);
        thread.start();
    }

    void run() {
        Set<String> seen = new HashSet<>();
        List<String> inbound = new ArrayList<>();
        Instant now = Instant.now();

        Instant oldestOut = oldest(outboundCalls.getCalls(new com.fathy.alfred.backend.calls.domain.model.CallsQuery("", "", "oldest", 0, 1))
                .calls().stream().map(c -> c.timestamp()).findFirst().orElse(null));
        for (Instant from = oldestOut; from != null && from.isBefore(now); from = from.plus(WINDOW)) {
            for (var call : outboundRange.getCallsInRange(from, from.plus(WINDOW), "", "")) {
                if (seen.add(call.id())) {
                    record.callObserved(withBody(TriageCallObserverAdapter.outbound(call),
                            id -> outboundDetail.getDetail(id).map(d -> d.response() == null ? null : d.response().body()).orElse(null)));
                }
            }
        }
        Instant oldestIn = oldest(inboundCalls.getCalls(new com.fathy.alfred.backend.internalcalls.domain.model.CallsQuery("", "", "oldest", 0, 1, "", "", "", ""))
                .calls().stream().map(c -> c.timestamp()).findFirst().orElse(null));
        for (Instant from = oldestIn; from != null && from.isBefore(now); from = from.plus(WINDOW)) {
            for (var call : inboundRange.getCallsInRange(from, from.plus(WINDOW), "", "", "", "", "")) {
                if (seen.add(call.id())) {
                    inbound.add(call.id());
                    record.callObserved(withBody(TriageCallObserverAdapter.inbound(call),
                            id -> inboundDetail.getDetail(id).map(d -> d.response() == null ? null : d.response().body()).orElse(null)));
                }
            }
        }
        for (SessionCycle cycle : cycles.listAll()) {
            cycleCalls.inbound(cycle.id(), captured -> {
                var summary = captured.call();
                if (seen.add(summary.id())) {
                    inbound.add(summary.id());
                    var response = capturedInternalCallDetail.getDetail(cycle.id(), summary.id()).map(d -> d.response()).orElse(null);
                    record.callObserved(new ObservedCall(summary.id(), CallDirection.INBOUND, summary.serviceName(), null, summary.method(),
                            summary.url(), summary.status(), summary.error(), summary.timestamp(), summary.durationMs(),
                            summary.state() == null ? null : summary.state().name(), response == null ? null : response.body()));
                }
            });
            cycleCalls.outbound(cycle.id(), captured -> {
                var summary = captured.call();
                if (seen.add(summary.id())) {
                    var response = capturedCallDetail.getDetail(cycle.id(), summary.id()).map(d -> d.response()).orElse(null);
                    record.callObserved(new ObservedCall(summary.id(), CallDirection.OUTBOUND, null, summary.parentCallId(), summary.method(),
                            summary.url(), summary.status(), summary.error(), summary.timestamp(), summary.durationMs(),
                            summary.state() == null ? null : summary.state().name(), response == null ? null : response.body()));
                }
            });
        }
        for (int i = 0; i < inbound.size(); i += FindStatementFailuresUseCase.MAX_IDS) {
            statementFailures.failures(inbound.subList(i, Math.min(inbound.size(), i + FindStatementFailuresUseCase.MAX_IDS)))
                    .forEach((callId, failures) -> record.statementFailures(callId, failures.failedCount(), failures.swallowedCount()));
        }
        record.backfillDone(seen.size());
    }

    /**
     * Range reads carry metadata only (no bodies - see SqliteCallsRepository.findResolvedInRange), so the body is read by
     * id, and only where it can change the mark: a response under 400 with no transport error.
     */
    private static ObservedCall withBody(ObservedCall call, java.util.function.Function<String, String> body) {
        if (call.responseBody() != null || call.status() == null || call.status() >= 400 || (call.error() != null && !call.error().isEmpty())) {
            return call;
        }
        return new ObservedCall(call.callId(), call.direction(), call.project(), call.parentCallId(), call.method(), call.url(), call.status(),
                call.error(), call.startedAt(), call.durationMs(), call.state(), body.apply(call.callId()));
    }

    /** The start of the day window loop: a little before the oldest call, read whichever way its time was written. */
    private static Instant oldest(String timestamp) {
        if (timestamp == null || timestamp.isBlank()) {
            return null;
        }
        try {
            return OffsetDateTime.parse(timestamp).toInstant().minusSeconds(1);
        } catch (DateTimeParseException e) {
            try {
                // A naive timestamp: its zone is unknown, so start a day early rather than miss a call.
                return LocalDateTime.parse(timestamp).toInstant(ZoneOffset.UTC).minus(Duration.ofDays(1));
            } catch (DateTimeParseException ignored) {
                return null;
            }
        }
    }
}
