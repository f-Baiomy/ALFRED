package com.fathy.alfred.backend.settings.adapter.out.filestore;

import com.fathy.alfred.backend.settings.application.port.out.GlobalVariablesStorePort;
import com.fathy.alfred.backend.settings.domain.model.GlobalVariablesState;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.UnaryOperator;

/**
 * File-storage counterpart of the SQLite store. There is no separate DB here, so the ONE file
 * this deployment has ({@code INTERCEPTION_VARIABLES_FILE}) holds both roles at once: the
 * backend's own multi-environment truth (the {@code activeEnvironment}/{@code environments}/
 * {@code secrets} keys - see {@link GlobalVariablesState}) AND, alongside it in the same JSON
 * object, the flat published view the proxy reads and writes a GLOBAL capture's {@code
 * promotedAt}/{@code promotedBy} into (the {@code environment}/{@code variables}/{@code
 * fallbacks}/{@code updatedAt} keys - see {@link GlobalVariablesState#publishedView}). Every
 * write re-derives the published view from the nested truth, so the two never drift apart.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.filter-settings", name = "type", havingValue = "file")
public class JsonFileGlobalVariablesRepository implements GlobalVariablesStorePort {
    private final ObjectMapper mapper = new ObjectMapper();
    @Value("${INTERCEPTION_VARIABLES_FILE:/appdata/interception/variables.json}")
    private String file;

    @Override public synchronized Map<String, Object> load() {
        Map<String, Object> raw = readRaw();
        Map<String, Object> state = GlobalVariablesState.migrate(raw);
        Map<String, Object> absorbed = GlobalVariablesState.absorb(state, raw);
        if (absorbed != null) {
            // Persisted immediately (like the SQLite adapter's own load()) so the CAPTURE source
            // and bumped updatedAt survive even if no other mutation happens to write them out.
            save(absorbed);
            return absorbed;
        }
        return state;
    }

    @Override public synchronized Map<String, Object> save(Map<String, Object> state) {
        Map<String, Object> onDisk = new LinkedHashMap<>(state);
        onDisk.putAll(GlobalVariablesState.publishedView(state));
        Path target = Path.of(file).toAbsolutePath();
        try {
            Files.createDirectories(target.getParent());
            Path temp = Files.createTempFile(target.getParent(), ".variables", ".tmp");
            try {
                mapper.writeValue(temp.toFile(), onDisk);
                // Retried: on Windows a replace fails while the proxy has the file open to read it (see
                // GlobalVariablesRepository.replace, the SQLite mode's publish).
                for (int attempt = 1; ; attempt++) {
                    try {
                        try { Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE); }
                        catch (AtomicMoveNotSupportedException e) { Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING); }
                        break;
                    } catch (java.nio.file.AccessDeniedException e) {
                        if (attempt >= 40) throw e;
                        try { Thread.sleep(25); }
                        catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw e; }
                    }
                }
            } finally { Files.deleteIfExists(temp); }
            return state;
        } catch (IOException e) { throw new UncheckedIOException("Could not save global variables", e); }
    }

    private Map<String, Object> readRaw() {
        Path path = Path.of(file);
        if (!Files.exists(path)) return Map.of();
        try { return mapper.readValue(path.toFile(), new TypeReference<>() {}); }
        catch (IOException e) { throw new UncheckedIOException("Could not read global variables", e); }
    }

    /**
     * Load (absorption included) + {@code change} + save as one atomic operation under this
     * adapter's own lock, so a concurrent {@code promote}/{@code save} can no longer
     * read-modify-write the file unsynchronized and lose one side's write to the other.
     */
    @Override public synchronized GlobalVariablesStorePort.Update update(UnaryOperator<Map<String, Object>> change) {
        Map<String, Object> current = load();
        Map<String, Object> next = change.apply(current);
        if (next.equals(current)) return new GlobalVariablesStorePort.Update(current, false);
        return new GlobalVariablesStorePort.Update(save(next), true);
    }
}
