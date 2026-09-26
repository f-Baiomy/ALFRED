package com.fathy.alfred.backend.settings.adapter.out.filestore;

import com.fathy.alfred.backend.settings.application.port.out.GlobalVariablesStorePort;
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
import java.util.Map;

/** File-storage counterpart of the SQLite store. The proxy reads the same atomically written file. */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.filter-settings", name = "type", havingValue = "file")
public class JsonFileGlobalVariablesRepository implements GlobalVariablesStorePort {
    private final ObjectMapper mapper = new ObjectMapper();
    @Value("${INTERCEPTION_VARIABLES_FILE:/appdata/interception/variables.json}")
    private String file;

    @Override public synchronized Map<String, Object> load() {
        Path path = Path.of(file);
        if (!Files.exists(path)) return Map.of();
        try { return mapper.readValue(path.toFile(), new TypeReference<>() {}); }
        catch (IOException e) { throw new UncheckedIOException("Could not read global variables", e); }
    }

    @Override public synchronized Map<String, Object> save(Map<String, Object> state) {
        Path target = Path.of(file).toAbsolutePath();
        try {
            Files.createDirectories(target.getParent());
            Path temp = Files.createTempFile(target.getParent(), ".variables", ".tmp");
            try {
                mapper.writeValue(temp.toFile(), state);
                try { Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE); }
                catch (AtomicMoveNotSupportedException e) { Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING); }
            } finally { Files.deleteIfExists(temp); }
            return state;
        } catch (IOException e) { throw new UncheckedIOException("Could not save global variables", e); }
    }
}
