package com.fathy.alfred.backend.settings.adapter.out.sqlite;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import com.fathy.alfred.backend.settings.application.port.out.GlobalVariablesStorePort;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Map;

/** SQLite persistence and proxy snapshot publication for app-wide variables. */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.filter-settings", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class GlobalVariablesRepository implements GlobalVariablesStorePort {
    private final ObjectMapper mapper = new ObjectMapper();
    @Value("${FILTER_SETTINGS_DB_FILE:/appdata/settings.db}") private String dbFile;
    @Value("${INTERCEPTION_VARIABLES_FILE:/appdata/interception/variables.json}") private String variablesFile;
    private HikariDataSource dataSource;
    private JdbcTemplate jdbc;

    @PostConstruct void init() {
        Path path = Path.of(dbFile);
        try { if (path.getParent() != null) Files.createDirectories(path.getParent()); }
        catch (IOException e) { throw new UncheckedIOException("Could not create directory for " + dbFile, e); }
        HikariConfig config = new HikariConfig();
        config.setJdbcUrl("jdbc:sqlite:" + path);
        config.setMaximumPoolSize(4);
        config.setPoolName("global-variables-sqlite-pool");
        config.setConnectionInitSql("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=10000;");
        dataSource = new HikariDataSource(config);
        jdbc = new JdbcTemplate(dataSource);
        jdbc.execute("CREATE TABLE IF NOT EXISTS global_variables (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        publish(load());
    }
    @PreDestroy public void close() { if (dataSource != null) dataSource.close(); }
    @Override public synchronized Map<String, Object> load() {
        String json = jdbc.query("SELECT value FROM global_variables WHERE key='state'", (rs, n) -> rs.getString(1)).stream().findFirst().orElse("{}");
        try { return mapper.readValue(json, new TypeReference<>() {}); }
        catch (IOException e) { throw new IllegalStateException("Invalid global variables state", e); }
    }
    @Override public synchronized Map<String, Object> save(Map<String, Object> state) {
        try {
            String json = mapper.writeValueAsString(state);
            jdbc.update("INSERT INTO global_variables(key,value) VALUES('state',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", json);
            publish(state);
            return state;
        } catch (IOException e) { throw new IllegalStateException("Could not encode global variables", e); }
    }
    private void publish(Map<String, Object> state) {
        Path target = Path.of(variablesFile).toAbsolutePath();
        Path parent = target.getParent();
        try {
            Files.createDirectories(parent);
            Path temp = Files.createTempFile(parent, ".variables", ".tmp");
            try {
                mapper.writeValue(temp.toFile(), state);
                try { Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE); }
                catch (AtomicMoveNotSupportedException e) { Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING); }
            } finally { Files.deleteIfExists(temp); }
        } catch (IOException e) { throw new UncheckedIOException("Could not publish global variables to " + target, e); }
    }
}
