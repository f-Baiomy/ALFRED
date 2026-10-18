package com.fathy.alfred.backend.sessions.adapter.out.files;

import com.fathy.alfred.backend.sessions.application.port.out.ConnectFilesPort;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Stream;

/**
 * The files a "Connect this PC" file downloads, read from disk on every request (they change only when Alfred is
 * updated, and are small): Docker mounts helper/ and skills/ at /opt/alfred-connect and bakes node.exe into the image;
 * the native supervisor points these at the install's app/helper, app/skills and runtime/node.
 */
@Component
public class ConnectFilesAdapter implements ConnectFilesPort {

    static final String SHARED_RULES = "_shared/rules.md";
    static final long MAX_FILE = 2L * 1024 * 1024;

    private final Path helper;
    private final Path skills;
    private final Path node;

    public ConnectFilesAdapter(@Value("${ALFRED_CONNECT_HELPER:/opt/alfred-connect/helper/alfred-helper.mjs}") String helper,
                               @Value("${ALFRED_CONNECT_SKILLS:/opt/alfred-connect/skills}") String skills,
                               @Value("${ALFRED_CONNECT_NODE:/opt/alfred-connect/node.exe}") String node) {
        this.helper = Path.of(helper);
        this.skills = Path.of(skills);
        this.node = Path.of(node);
    }

    @Override
    public Optional<String> helperScript() {
        try {
            return Files.isRegularFile(helper) ? Optional.of(Files.readString(helper, StandardCharsets.UTF_8)) : Optional.empty();
        } catch (IOException e) {
            return Optional.empty();
        }
    }

    @Override
    public Map<String, String> skillFiles() {
        Map<String, String> out = new LinkedHashMap<>();
        if (!Files.isDirectory(skills)) {
            return out;
        }
        try {
            Path rules = skills.resolve(SHARED_RULES);
            String rulesText = Files.isRegularFile(rules) ? Files.readString(rules, StandardCharsets.UTF_8) : null;
            List<Path> dirs;
            try (Stream<Path> s = Files.list(skills)) {
                dirs = s.filter(d -> d.getFileName().toString().startsWith("alfred-") && Files.isRegularFile(d.resolve("SKILL.md"))).sorted().toList();
            }
            for (Path dir : dirs) {
                String name = dir.getFileName().toString();
                List<Path> files;
                try (Stream<Path> s = Files.walk(dir)) {
                    files = s.filter(Files::isRegularFile).filter(ConnectFilesAdapter::shipped).sorted().toList();
                }
                for (Path f : files) {
                    out.put(name + "/" + dir.relativize(f).toString().replace('\\', '/'), Files.readString(f, StandardCharsets.UTF_8));
                }
                if (rulesText != null) {
                    out.put(name + "/rules.md", rulesText);
                }
            }
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        return out;
    }

    private static boolean shipped(Path f) {
        String n = f.getFileName().toString();
        try {
            return !n.equals(".alfred-skill") && !n.endsWith(".pyc") && !f.toString().contains("__pycache__") && Files.size(f) <= MAX_FILE;
        } catch (IOException e) {
            return false;
        }
    }

    @Override
    public Optional<Path> nodeExe() {
        return Files.isRegularFile(node) ? Optional.of(node) : Optional.empty();
    }
}
