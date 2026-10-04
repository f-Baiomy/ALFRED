package com.fathy.alfred.backend.logs.application.service;

import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.BooleanSupplier;

/**
 * Wakes the reader of a watched file when that file changes. There is no timer: a reader that has read
 * everything blocks here until a change notification (the kernel's, or the host agent's) signals its
 * input - or until it is stopped. Signals are counted, so a change that arrives while the reader is
 * still busy is never lost: the next wait returns at once.
 */
@Component
public class FileChangeSignals {

    private static final class Signal {
        long version;
        long seen;
    }

    private final Map<String, Signal> signals = new ConcurrentHashMap<>();

    private Signal of(String inputId) {
        return signals.computeIfAbsent(inputId, k -> new Signal());
    }

    /** Something changed for this input (or it is being stopped): wake its reader. */
    public void signal(String inputId) {
        Signal s = of(inputId);
        synchronized (s) {
            s.version++;
            s.notifyAll();
        }
    }

    /**
     * Blocks until this input was signalled since the last return, or {@code stopped} is true.
     *
     * @return true when signalled, false when stopped
     */
    public boolean await(String inputId, BooleanSupplier stopped) throws InterruptedException {
        Signal s = of(inputId);
        synchronized (s) {
            while (s.version == s.seen && !stopped.getAsBoolean()) {
                s.wait();
            }
            s.seen = s.version;
        }
        return !stopped.getAsBoolean();
    }

    public void forget(String inputId) {
        signals.remove(inputId);
    }
}
