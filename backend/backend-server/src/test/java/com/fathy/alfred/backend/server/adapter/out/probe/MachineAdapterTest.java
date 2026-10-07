package com.fathy.alfred.backend.server.adapter.out.probe;

import com.fathy.alfred.backend.server.application.port.out.MachinePort;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

class MachineAdapterTest {

    @TempDir
    Path dir;

    @Test
    void aListeningSocketIsReportedBusyAndAFreedPortFree() throws Exception {
        MachineAdapter machine = new MachineAdapter(dir);
        int port;
        try (ServerSocket socket = new ServerSocket()) {
            socket.bind(new InetSocketAddress(0));
            port = socket.getLocalPort();
            assertThat(machine.portOwner(port)).isPresent();
        }
        assertThat(machine.portOwner(port)).isEmpty();
    }

    @Test
    void foldersAreCountedByNameWithoutBeingRead() throws Exception {
        Files.writeString(dir.resolve("server.log"), "x");
        Files.writeString(dir.resolve("app.json.1"), "x");
        Files.writeString(dir.resolve("notes.md"), "x");
        Files.createDirectory(dir.resolve("old.log.d"));
        MachinePort.FolderInfo info = new MachineAdapter(dir).folder(dir.toString());
        assertThat(info.exists()).isTrue();
        assertThat(info.readable()).isTrue();
        assertThat(info.logFiles()).isEqualTo(2);
        assertThat(info.newestModifiedMillis()).isPositive();
        assertThat(new MachineAdapter(dir).folder(dir.resolve("missing").toString()).exists()).isFalse();
    }

    @Test
    void anAppThatDoesNotListenIsNotAnswering() throws Exception {
        int port;
        try (ServerSocket socket = new ServerSocket(0)) {
            port = socket.getLocalPort();
        }
        MachinePort.AppHealth health = new MachineAdapter(dir).appHealth(port);
        assertThat(health.answering()).isFalse();
        assertThat(health.reason()).contains(String.valueOf(port));
    }

    @Test
    void diskAndMemoryAreKnown() {
        MachineAdapter machine = new MachineAdapter(dir);
        assertThat(machine.freeDiskBytes()).isPositive();
        assertThat(machine.totalMemoryBytes()).isPositive();
    }
}
