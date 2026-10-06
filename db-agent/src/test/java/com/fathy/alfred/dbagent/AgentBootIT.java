package com.fathy.alfred.dbagent;

import org.example.boot.AgentBootCheck;
import org.junit.jupiter.api.Test;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The agent must not touch java.util.logging while it starts: WildFly names its own LogManager after the agent's
 * premain, and a JVM whose LogManager is already initialised makes WildFly refuse to boot (WFLYLOG0078 - seen live
 * with the first log-catching agent). Runs in a fresh JVM, since this one's logging is long initialised.
 */
class AgentBootIT {

    @Test
    void theApplicationServersLogManagerStillWinsAfterTheAgentStarted() throws Exception {
        String java = System.getProperty("java.home") + File.separator + "bin" + File.separator + "java";
        List<String> command = new ArrayList<>();
        command.add(java);
        command.add("-Djdk.attach.allowAttachSelf=true");
        command.add("-cp");
        command.add(System.getProperty("java.class.path"));
        command.add(AgentBootCheck.class.getName());
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        String output;
        try (BufferedReader in = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            output = in.lines().collect(Collectors.joining("\n"));
        }
        assertThat(process.waitFor(60, TimeUnit.SECONDS)).isTrue();

        assertThat(output).contains("LOG_MANAGER=" + AgentBootCheck.BootLogManager.class.getName());
    }
}
