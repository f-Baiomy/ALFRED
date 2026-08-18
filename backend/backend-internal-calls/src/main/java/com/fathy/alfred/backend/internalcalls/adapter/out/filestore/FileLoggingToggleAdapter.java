package com.fathy.alfred.backend.internalcalls.adapter.out.filestore;

import com.fathy.alfred.backend.internalcalls.application.port.out.LoggingTogglePort;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Locale;

/**
 * Reads/writes the exact same flag file proxy/log_and_route_reverse.py polls (via mtime) and
 * toggle-wildfly-reverse-proxy.sh/.bat already edit by hand - see docker-compose.yml's
 * wildfly-proxy AND backend services, both of which bind-mount ./proxy/reverse-proxy-enabled.flag
 * (at different in-container paths). This adapter is just a third way to flip the same file; it
 * doesn't own the file any more than the shell scripts do, so it re-reads on every call rather
 * than caching - this is a low-frequency, human-driven setting, not a hot path.
 */
@Component
public class FileLoggingToggleAdapter implements LoggingTogglePort {

    private static final Logger log = LoggerFactory.getLogger(FileLoggingToggleAdapter.class);

    @Value("${REVERSE_PROXY_TOGGLE_FILE:/appdata/reverse-proxy-enabled.flag}")
    private String toggleFile;

    /** Mirrors log_and_route_reverse.py's _ToggleState.enabled() exactly: missing file or anything other than a literal "off" (case-insensitive) counts as enabled. */
    @Override
    public boolean isEnabled() {
        Path path = Path.of(toggleFile);
        if (!Files.exists(path)) {
            return true;
        }
        try {
            String content = Files.readString(path).strip().toLowerCase(Locale.ROOT);
            return !content.equals("off");
        } catch (IOException e) {
            log.warn("Could not read {}, defaulting to enabled: {}", toggleFile, e.getMessage());
            return true;
        }
    }

    @Override
    public void setEnabled(boolean enabled) {
        Path path = Path.of(toggleFile);
        try {
            if (path.getParent() != null) {
                Files.createDirectories(path.getParent());
            }
            Files.writeString(path, enabled ? "on\n" : "off\n",
                    StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE);
        } catch (IOException e) {
            log.error("Failed to write {}: {}", toggleFile, e.getMessage());
            throw new UncheckedIOException(e);
        }
    }
}
