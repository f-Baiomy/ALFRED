package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.application.port.out.TeamCachePort;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Instant;

/**
 * teamboards.db retention (specs/028 data-model "Retention"): 50 syncs per item, decided Incoming 90 days, ended bundles
 * 180 days, waiting hook ids 7 days, a start's files 24 hours. Housekeeping, not a poll: nothing a page shows waits on it.
 */
@Component
public class TeamRetention {

    private static final Logger log = LoggerFactory.getLogger(TeamRetention.class);

    private final TeamCachePort cache;

    public TeamRetention(TeamCachePort cache) {
        this.cache = cache;
    }

    @Scheduled(initialDelayString = "PT5M", fixedDelayString = "PT6H")
    public void trim() {
        try {
            int n = cache.trim(Instant.now());
            if (n > 0) {
                log.info("Team retention removed {} rows", n);
            }
        } catch (RuntimeException e) {
            log.warn("Team retention did not run: {}", e.getClass().getSimpleName());
        }
    }
}
