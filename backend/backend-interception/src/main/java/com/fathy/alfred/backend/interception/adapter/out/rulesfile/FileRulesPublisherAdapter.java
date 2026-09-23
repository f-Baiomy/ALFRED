package com.fathy.alfred.backend.interception.adapter.out.rulesfile;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.interception.application.port.out.RulesPublisherPort;
import com.fathy.alfred.backend.interception.domain.model.InterceptionRule;
import com.fathy.alfred.backend.interception.domain.model.PatternSafety;
import com.fathy.alfred.backend.interception.domain.model.SelfTargets;
import com.fathy.alfred.backend.interception.domain.model.SensitiveHeaders;
import com.fathy.alfred.backend.interception.domain.model.StoredAnswer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;

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

    /** Beside the snapshot, in the directory already shared with both proxies. */
    static final String ANSWERS_DIR = "answers";
    static final String META_SUFFIX = ".meta.json";
    static final String BODY_SUFFIX = ".body";

    private final ObjectMapper mapper = new ObjectMapper();

    @Value("${INTERCEPTION_RULES_FILE:/appdata/interception-rules.json}")
    private String rulesFile;

    /** Published so the proxy's regex worker and this backend agree on the one budget. */
    @Value("${INTERCEPTION_REGEX_TIMEOUT_MS:2000}")
    private int regexTimeoutMs = 2000;

    private final SelfTargets selfTargets;

    public FileRulesPublisherAdapter(SelfTargets selfTargets) {
        this.selfTargets = selfTargets;
    }

    @Override
    public synchronized void publish(boolean enabled, List<InterceptionRule> rules, List<PublishedAnswer> answers) {
        List<InterceptionRule> active = rules.stream().filter(InterceptionRule::enabled).toList();

        Map<String, Object> snapshot = new LinkedHashMap<>();
        snapshot.put("enabled", enabled);
        // Purely for a human who opens the file while debugging - the proxy ignores both.
        snapshot.put("publishedAt", java.time.Instant.now().toString());
        snapshot.put("rules", active);
        // Three things the proxy needs that are not rules. Each has ONE owner here, so the engine
        // never keeps a second copy that could drift from what the backend validated against.
        snapshot.put("sensitiveHeaders", SensitiveHeaders.NAMES.stream().sorted().toList());
        snapshot.put("selfTargets", selfTargets.published());
        snapshot.put("limits", Map.of(
                "maxPatternLength", PatternSafety.MAX_PATTERN_LENGTH,
                "regexTimeoutMs", regexTimeoutMs));

        Path path = Path.of(rulesFile).toAbsolutePath();
        try {
            Files.createDirectories(path.getParent());
            // Answers first, the snapshot after: a proxy that sees a rule can always find its answer.
            Path answersDir = path.getParent().resolve(ANSWERS_DIR);
            Set<String> published = writeAnswers(answersDir, answers);
            writeAtomically(path.getParent(), path, mapper.writeValueAsBytes(snapshot));
            deleteUnpublishedAnswers(answersDir, published);
            log.info("Published {} active interception rule(s), master switch {}", active.size(),
                    enabled ? "ON" : "off");
        } catch (IOException e) {
            // Never swallowed: if this fails the UI and the traffic disagree about what is
            // running, which is the worst state this feature can be in.
            log.error("Could not publish interception rules to {} - the proxy is still running the "
                    + "previous rule set: {}", rulesFile, e.getMessage());
        }
    }

    /**
     * Writes {@code <id>.body} and then {@code <id>.meta.json} for every answer not already there.
     * Answers are immutable, so an id whose meta file exists is complete and is not rewritten - the
     * body supplier is not even called.
     */
    private Set<String> writeAnswers(Path dir, List<PublishedAnswer> answers) throws IOException {
        Set<String> ids = new HashSet<>();
        if (answers.isEmpty() && !Files.isDirectory(dir)) {
            return ids;
        }
        Files.createDirectories(dir);
        for (PublishedAnswer answer : answers) {
            String id = answer.meta().id();
            if (!StoredAnswer.isValidId(id)) {
                // Never joined onto a path. The validator already refuses such an id on save.
                log.warn("Not publishing a stored answer with an invalid id");
                continue;
            }
            ids.add(id);
            Path meta = dir.resolve(id + META_SUFFIX);
            if (Files.exists(meta)) {
                continue;
            }
            writeAtomically(dir, dir.resolve(id + BODY_SUFFIX), answer.body().get());
            writeAtomically(dir, meta, mapper.writeValueAsBytes(proxyMeta(answer.meta())));
        }
        return ids;
    }

    /** What the proxy needs to serve an answer - no source call, no secret names, nothing it would not use. */
    private static Map<String, Object> proxyMeta(StoredAnswer answer) {
        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("id", answer.id());
        meta.put("kind", answer.kind() == null ? null : answer.kind().name());
        meta.put("status", answer.status());
        meta.put("headers", answer.headers());
        meta.put("contentType", answer.contentType());
        meta.put("sizeBytes", answer.sizeBytes());
        meta.put("recordedAt", answer.recordedAt());
        return meta;
    }

    /** Removes the files of every answer no published rule uses any more. */
    private void deleteUnpublishedAnswers(Path dir, Set<String> keep) throws IOException {
        if (!Files.isDirectory(dir)) {
            return;
        }
        try (Stream<Path> files = Files.list(dir)) {
            for (Path file : files.toList()) {
                String name = file.getFileName().toString();
                String id = name.endsWith(META_SUFFIX) ? name.substring(0, name.length() - META_SUFFIX.length())
                        : name.endsWith(BODY_SUFFIX) ? name.substring(0, name.length() - BODY_SUFFIX.length())
                        : null;
                if (id != null && !keep.contains(id)) {
                    Files.deleteIfExists(file);
                }
            }
        }
    }

    private void writeAtomically(Path dir, Path target, byte[] content) throws IOException {
        Path temp = Files.createTempFile(dir, ".alfred", ".tmp");
        try {
            Files.write(temp, content);
            move(temp, target);
        } catch (IOException e) {
            Files.deleteIfExists(temp);
            throw e;
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
