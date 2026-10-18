package com.fathy.alfred.backend.sessions.application.port.out;

import java.nio.file.Path;
import java.util.Map;
import java.util.Optional;

/**
 * What a "Connect this PC" file downloads from Alfred (specs/031): the helper script, the /alfred-* skills as installed
 * (each with its rules.md) and, for a Windows PC without Node, a node.exe. Read from the files this Alfred ships - the
 * Docker image's /opt/alfred-connect, or the native install's app folder.
 */
public interface ConnectFilesPort {

    Optional<String> helperScript();

    /** The skills as they are installed: {@code alfred-live/SKILL.md} → its text, one entry per file. Empty without them. */
    Map<String, String> skillFiles();

    /** node.exe (Windows x64) to hand to a PC without Node 18+, when this Alfred carries one. */
    Optional<Path> nodeExe();
}
