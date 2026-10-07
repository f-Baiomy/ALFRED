package com.fathy.alfred.backend.mcpbridge;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Files Claude's export_calls wrote on this server (specs/012-server-program FR-083): over HTTP the caller cannot read
 * the server's disk, so the MCP server saves into ALFRED_EXPORT_DIR and answers with /mcp-exports/&lt;name&gt;. One
 * file name, never a path; files older than 7 days are deleted at start.
 */
@RestController
public class McpExportsController {

    private static final Logger log = LoggerFactory.getLogger(McpExportsController.class);
    static final Duration KEEP = Duration.ofDays(7);
    private static final Pattern NAME = Pattern.compile("[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,199}");

    private final Path folder;

    public McpExportsController(@Value("${ALFRED_EXPORT_DIR:}") String folder) {
        this.folder = folder.isBlank() ? null : Path.of(folder).toAbsolutePath().normalize();
    }

    @GetMapping("/mcp-exports/{name}")
    public ResponseEntity<Resource> download(@PathVariable String name) {
        if (folder == null || !NAME.matcher(name).matches() || name.contains("..")) {
            return ResponseEntity.notFound().build();
        }
        Path file = folder.resolve(name).normalize();
        if (!file.getParent().equals(folder) || !Files.isRegularFile(file)) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.attachment().filename(name, StandardCharsets.UTF_8).build().toString())
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .body(new FileSystemResource(file));
    }

    @EventListener(ApplicationReadyEvent.class)
    public void deleteOldExports() {
        deleteOlderThan(Instant.now().minus(KEEP));
    }

    void deleteOlderThan(Instant cutoff) {
        if (folder == null || !Files.isDirectory(folder)) {
            return;
        }
        try (Stream<Path> files = Files.list(folder)) {
            files.filter(Files::isRegularFile).forEach(file -> {
                try {
                    if (Files.getLastModifiedTime(file).toInstant().isBefore(cutoff)) {
                        Files.delete(file);
                    }
                } catch (IOException e) {
                    log.warn("Could not delete old export {}: {}", file.getFileName(), e.getMessage());
                }
            });
        } catch (IOException e) {
            log.warn("Could not list {}: {}", folder, e.getMessage());
        }
    }
}
