package com.fathy.alfred.backend.storage;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Supplier;

/**
 * Counts the calls removed outside the storage page's own actions - the limits trimming as calls arrive, a Relive
 * run's history, a clear elsewhere - and writes them to the clean-up history once an hour, as one "Auto" line per
 * direction. The page's own deletes run inside {@link #manual} and write their own line, so nothing counts twice.
 */
@Component
class StorageActivity {

    private static final ThreadLocal<Boolean> MANUAL = ThreadLocal.withInitial(() -> false);

    private final StorageFiles files;
    private final AtomicLong inbound = new AtomicLong();
    private final AtomicLong outbound = new AtomicLong();

    StorageActivity(StorageFiles files) {
        this.files = files;
    }

    <T> T manual(Supplier<T> work) {
        boolean before = MANUAL.get();
        MANUAL.set(true);
        try {
            return work.get();
        } finally {
            MANUAL.set(before);
        }
    }

    /** Called on the deleting thread, before the cascade's own thread takes over. */
    void removed(boolean inboundCalls, int count) {
        if (count <= 0 || MANUAL.get()) {
            return;
        }
        (inboundCalls ? inbound : outbound).addAndGet(count);
    }

    @Scheduled(fixedDelay = 3_600_000, initialDelay = 3_600_000)
    void flush() {
        long in = inbound.getAndSet(0);
        long out = outbound.getAndSet(0);
        if (in > 0) {
            files.addHistory("auto", in + " inbound calls removed by the limits and other deletes, with their captured data", -1);
        }
        if (out > 0) {
            files.addHistory("auto", out + " outbound calls removed by the limits and other deletes", -1);
        }
    }
}
