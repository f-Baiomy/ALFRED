package com.fathy.alfred.backend.redactions.adapter.out.sqlite;

import com.fathy.alfred.backend.redactions.application.port.out.RedactionsStorePort;
import com.fathy.alfred.backend.redactions.domain.model.Redaction;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Thin RedactionsStorePort implementation - all SQL/JDBC detail lives in
 * {@link SqliteRedactionsRepository}. The default; set {@code alfred.storage.redactions.type=file}
 * to opt into {@code JsonFileRedactionsStoreAdapter}.
 *
 * <p>Unlike SqliteCommentsStoreAdapter there is no legacy-file migration step here: redactions are
 * a new feature, so no deployment has a redactions.json predating SQLite to import.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.redactions", name = "type", havingValue = "sqlite", matchIfMissing = true)
public class SqliteRedactionsStoreAdapter implements RedactionsStorePort {

    private final SqliteRedactionsRepository repository;

    public SqliteRedactionsStoreAdapter(SqliteRedactionsRepository repository) {
        this.repository = repository;
    }

    @Override
    public List<Redaction> findAll() {
        return repository.findAll();
    }

    @Override
    public Redaction save(Redaction redaction) {
        return repository.save(redaction);
    }

    @Override
    public boolean deleteById(String id) {
        return repository.deleteById(id);
    }

    @Override
    public void replaceAll(List<Redaction> redactions) {
        repository.replaceAll(redactions);
    }

    @Override
    public long storageSizeBytes() {
        return repository.storageSizeBytes();
    }
}
