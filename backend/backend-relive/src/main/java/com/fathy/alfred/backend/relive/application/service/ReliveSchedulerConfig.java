package com.fathy.alfred.backend.relive.application.service;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.concurrent.Executor;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;

/** The single {@link ScheduledExecutorService} shared by {@link ReliveRunsService}'s STOPPING
 *  drain timer and T047's RunLeaseRegistry - one background thread is plenty for occasional,
 *  short-lived delayed tasks (constructor-injected everywhere else so tests can swap in a
 *  controllable fake). */
@Configuration
public class ReliveSchedulerConfig {

    @Bean
    public ScheduledExecutorService reliveScheduledExecutorService() {
        return Executors.newSingleThreadScheduledExecutor(r -> {
            Thread thread = new Thread(r, "relive-scheduler");
            thread.setDaemon(true);
            return thread;
        });
    }

    /** Runs the relive history delete's logged-call cleanup off the request thread - the delete
     *  responds as soon as the run history itself is gone, and each call store broadcasts its own
     *  "calls-cleared" the moment its rows are actually removed. Deliberately NOT the scheduler
     *  above: scanning a large call log must never delay a drain timer or a lease interrupt.
     *  Single-threaded so two overlapping deletes can't interleave their cleanup work. */
    @Bean
    public Executor reliveCallsCleanupExecutor() {
        return Executors.newSingleThreadExecutor(r -> {
            Thread thread = new Thread(r, "relive-calls-cleanup");
            thread.setDaemon(true);
            return thread;
        });
    }
}
