package com.fathy.alfred.backend.relive.application.service;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

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
}
