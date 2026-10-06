package com.fathy.alfred.backend.triagebridge;

import com.fathy.alfred.backend.dbcapture.application.port.in.RepublishCallSignalsUseCase;
import com.fathy.alfred.backend.triage.application.port.in.RecordCallAttentionUseCase;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * Once, on the first start of specs/010-mcp-log-investigation: every call db-capture holds hands its log and database
 * signals to triage (through {@link TriageCallSignalsAdapter}), so calls captured before this version are found by
 * problem calls too. In the background; a marker row in triage.db makes it run only once.
 */
@Component
public class TriageSignalsBackfill {

    private static final Logger log = LoggerFactory.getLogger(TriageSignalsBackfill.class);

    private final RecordCallAttentionUseCase record;
    private final RepublishCallSignalsUseCase republish;

    public TriageSignalsBackfill(RecordCallAttentionUseCase record, RepublishCallSignalsUseCase republish) {
        this.record = record;
        this.republish = republish;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void startInBackground() {
        if (!record.signalsBackfillNeeded()) {
            return;
        }
        Thread thread = new Thread(this::run, "triage-signals-backfill");
        thread.setDaemon(true);
        thread.start();
    }

    void run() {
        try {
            record.signalsBackfillDone(republish.republishAll());
        } catch (RuntimeException e) {
            // not marked done: the next start tries again
            log.error("triage: taking the signals of calls captured before this version failed", e);
        }
    }
}
