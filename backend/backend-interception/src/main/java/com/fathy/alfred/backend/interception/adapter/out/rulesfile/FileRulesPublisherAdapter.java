package com.fathy.alfred.backend.interception.adapter.out.rulesfile;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.interception.application.port.out.RulesPublisherPort;
import com.fathy.alfred.backend.interception.domain.model.InterceptionRule;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Writes the rules snapshot both mitmproxy addons read.
 *
 * <p>This file is the entire backend→proxy channel for interception, and the counterpart of
 * {@code proxy/interception.py}'s {@code _RulesCache}. It is bind-mounted into the backend and
 * both proxy containers at once, exactly like {@code reverse-proxy-enabled.flag} already is (see
 * docker-compose.yml and FileLoggingToggleAdapter).
 *
 * <p><b>The write is atomic and that is load-bearing.</b> The proxy picks the file up by mtime and
 * parses it whole; a reader that catches it half-written gets a JSON error, and the loader's
 * (correct) response to a corrupt file is to disable interception entirely. Writing in place would
 * therefore turn every single save into a brief window where every rule silently stops applying.
 * Temp file in the same directory, then move - the same technique
 * InternalCallsFileLogAdapter.save uses for its compaction, and for the same reason.
 *
 * <p>Only ENABLED rules are written. The proxy has no use for a disabled rule and filtering here
 * rather than there keeps the hot path's rule list as short as the user's intent allows - a
 * deployment with forty rules of which two are on costs two match attempts per call, not forty.
 */
@Component
public class FileRulesPublisherAdapter implements RulesPublisherPort {

    private static final Logger log = LoggerFactory.getLogger(FileRulesPublisherAdapter.class);

    private final ObjectMapper mapper = new ObjectMapper();

    @Value("${INTERCEPTION_RULES_FILE:/appdata/interception-rules.json}")
    private String rulesFile;

    @Override
    public synchronized void publish(boolean enabled, List<InterceptionRule> rules) {
        List<InterceptionRule> active = rules.stream().filter(InterceptionRule::enabled).toList();

        Map<String, Object> snapshot = new LinkedHashMap<>();
        snapshot.put("enabled", enabled);
        // Purely for a human who opens the file while debugging - the proxy ignores both.
        snapshot.put("publishedAt", java.time.Instant.now().toString());
        snapshot.put("rules", active);

        Path path = Path.of(rulesFile);
        try {
            if (path.getParent() != null) {
                Files.createDirectories(path.getParent());
            }
            Path temp = Files.createTempFile(path.getParent(), ".interception-rules", ".tmp");
            try {
                Files.writeString(temp, mapper.writeValueAsString(snapshot), StandardCharsets.UTF_8);
                move(temp, path);
            } catch (IOException e) {
                Files.deleteIfExists(temp);
                throw e;
            }
            log.info("Published {} active interception rule(s), master switch {}", active.size(),
                    enabled ? "ON" : "off");
        } catch (IOException e) {
            // Never swallowed: if this fails the UI and the traffic disagree about what is
            // running, which is the worst state this feature can be in.
            log.error("Could not publish interception rules to {} - the proxy is still running the "
                    + "previous rule set: {}", rulesFile, e.getMessage());
        }
    }

    private void move(Path temp, Path target) throws IOException {
        try {
            Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException e) {
            // Some bind-mounted filesystems (notably Docker Desktop on Windows) refuse an atomic
            // move across the mount boundary. A plain replace is still far better than an
            // in-place rewrite, and the proxy tolerates the much smaller window.
            Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
        }
    }
}
