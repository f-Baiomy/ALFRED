package com.fathy.alfred.backend.links.application.service;

import com.fathy.alfred.backend.links.application.port.in.ReadLogUseCase;
import com.fathy.alfred.backend.links.application.port.out.LinksStorePort;
import com.fathy.alfred.backend.links.domain.model.ReadEntry;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;

/** The owner's read log (D31): one row per link, kind of thing, thing and day - counted, kept 30 days. */
@Service
public class ReadLogService implements ReadLogUseCase {

    static final int KEEP_DAYS = 30;

    private final LinksStorePort store;
    private final Clock clock;
    private volatile String prunedDay = "";

    @org.springframework.beans.factory.annotation.Autowired
    public ReadLogService(LinksStorePort store) {
        this(store, Clock.systemUTC());
    }

    ReadLogService(LinksStorePort store, Clock clock) {
        this.store = store;
        this.clock = clock;
    }

    @Override
    public void record(String linkId, String family, String target, String via) {
        Instant now = clock.instant();
        store.countRead(linkId, family, target, via, now);
        String today = now.toString().substring(0, 10);
        if (!today.equals(prunedDay)) {
            prunedDay = today;
            store.pruneReads(now.minus(KEEP_DAYS, ChronoUnit.DAYS).toString().substring(0, 10));
        }
    }

    @Override
    public List<ReadEntry> entries(String linkId, int days) {
        int d = Math.max(1, Math.min(days, KEEP_DAYS));
        return store.reads(linkId, clock.instant().minus(d - 1L, ChronoUnit.DAYS).toString().substring(0, 10));
    }
}
