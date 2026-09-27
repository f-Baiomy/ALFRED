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
import com.fathy.alfred.backend.settings.domain.model.GlobalVariablesState;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Map;
import java.util.function.UnaryOperator;

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
        Map<String, Object> state = GlobalVariablesState.migrate(readState());
        Map<String, Object> absorbed = GlobalVariablesState.absorb(state, readFileStateOrNull());
        if (absorbed != null) {
            writeState(absorbed);
            return absorbed;
        }
        return state;
    }
    @Override public synchronized Map<String, Object> save(Map<String, Object> state) {
        writeState(state);
        publish(state);
        return state;
    }
    /**
     * Runs load (absorption included) + {@code change} + save atomically under this adapter's own
     * lock, so a concurrent {@code promote}/{@code save} can no longer read-modify-write the state
     * unsynchronized and lose one side's write to the other. Skips the write/publish entirely when
     * {@code change} returns the same state it was given (see {@link GlobalVariablesStorePort#update}).
     */
    @Override public synchronized GlobalVariablesStorePort.Update update(UnaryOperator<Map<String, Object>> change) {
        Map<String, Object> current = load();
        Map<String, Object> next = change.apply(current);
        if (next.equals(current)) return new GlobalVariablesStorePort.Update(current, false);
        return new GlobalVariablesStorePort.Update(save(next), true);
    }
    private Map<String, Object> readState() {
        String json = jdbc.query("SELECT value FROM global_variables WHERE key='state'", (rs, n) -> rs.getString(1)).stream().findFirst().orElse("{}");
        try { return mapper.readValue(json, new TypeReference<>() {}); }
        catch (IOException e) { throw new IllegalStateException("Invalid global variables state", e); }
    }
    private void writeState(Map<String, Object> state) {
        try {
            String json = mapper.writeValueAsString(state);
            jdbc.update("INSERT INTO global_variables(key,value) VALUES('state',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", json);
        } catch (IOException e) { throw new IllegalStateException("Could not encode global variables", e); }
    }
    /**
     * The published file, read back so a proxy GLOBAL capture (which writes {@code promotedAt}/
     * {@code promotedBy} into it - see {@code interception.py::_save_global}) can be folded into
     * the DB by {@link GlobalVariablesState#absorb}. Best-effort by design: anything unreadable or
     * invalid returns {@code null} (no absorption), never thrown - a half-written or hand-edited
     * file must not break the panel.
     */
    private Map<String, Object> readFileStateOrNull() {
        try {
            Path path = Path.of(variablesFile);
            if (!Files.exists(path)) return null;
            return mapper.readValue(path.toFile(), new TypeReference<>() {});
        } catch (Exception e) {
            return null;
        }
    }

    private void publish(Map<String, Object> state) {
        Map<String, Object> published = GlobalVariablesState.publishedView(state);
        Path target = Path.of(variablesFile).toAbsolutePath();
        Path parent = target.getParent();
        try {
            Files.createDirectories(parent);
            Path temp = Files.createTempFile(parent, ".variables", ".tmp");
            try {
                mapper.writeValue(temp.toFile(), published);
                try { Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE); }
                catch (AtomicMoveNotSupportedException e) { Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING); }
            } finally { Files.deleteIfExists(temp); }
        } catch (IOException e) { throw new UncheckedIOException("Could not publish global variables to " + target, e); }
    }
}
