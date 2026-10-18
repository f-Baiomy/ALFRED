package com.fathy.alfred.backend.sessions.application.port.in;

import java.nio.file.Path;
import java.util.Map;
import java.util.Optional;

/**
 * "Connect this PC" (specs/031): one file the browser downloads and the user runs once. It fetches the helper (and Node
 * when the PC has none) from this Alfred, registers it with the Claude account the PC is signed in with, pairs the
 * browser that downloaded it, installs the /alfred-* skills and Alfred's MCP server, and keeps all of them current: the
 * helper compares {@link #versions()} on every heartbeat.
 */
public interface ConnectUseCase {

    /** What the helper and the skills are now (content hashes), and whether a node.exe can be handed out. */
    Versions versions();

    record Versions(String helper, String skills, boolean node) {
    }

    Optional<String> helperScript();

    Optional<Skills> skills();

    record Skills(String version, Map<String, String> files) {
    }

    Optional<Path> nodeExe();

    /**
     * The file for {@code os} ("windows" → a .cmd, anything else → a .sh) that connects a PC to {@code server} with the
     * one-time {@code token}. {@code server} must be a plain origin (scheme, host, port) - it is written into a script.
     */
    Script script(String server, String token, String os);

    record Script(String fileName, String text, String run) {
    }
}
