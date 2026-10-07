package com.fathy.alfred.backend.server.application.port.out;

import java.time.Instant;

/** Facts about this backend process: version, install folder, start time, pid and heap. */
public interface RuntimeInfoPort {

    String version();

    String installDir();

    Instant startedAt();

    long pid();

    long heapUsedBytes();

    long heapMaxBytes();
}
