package com.fathy.alfred.backend.server.adapter.out.runtime;

import com.fathy.alfred.backend.server.application.port.out.RuntimeInfoPort;

import java.lang.management.ManagementFactory;
import java.time.Instant;

/** Version and install folder come from the supervisor (ALFRED_VERSION, ALFRED_HOME); the rest from the JVM itself. */
public class JvmRuntimeInfoAdapter implements RuntimeInfoPort {

    private final String version;
    private final String installDir;

    public JvmRuntimeInfoAdapter(String version, String installDir) {
        this.version = version == null || version.isBlank() ? "dev" : version;
        this.installDir = installDir == null ? "" : installDir;
    }

    @Override
    public String version() {
        return version;
    }

    @Override
    public String installDir() {
        return installDir;
    }

    @Override
    public Instant startedAt() {
        return Instant.ofEpochMilli(ManagementFactory.getRuntimeMXBean().getStartTime());
    }

    @Override
    public long pid() {
        return ProcessHandle.current().pid();
    }

    @Override
    public long heapUsedBytes() {
        Runtime runtime = Runtime.getRuntime();
        return runtime.totalMemory() - runtime.freeMemory();
    }

    @Override
    public long heapMaxBytes() {
        return Runtime.getRuntime().maxMemory();
    }
}
