package com.fathy.alfred.backend.interception.adapter.out.filestore;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.interception.application.port.out.StoredAnswersStorePort;
import com.fathy.alfred.backend.interception.domain.model.StoredAnswer;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * The {@code type=file} store for stored answers: the metadata in one {@code index.json}, each body
 * as {@code <id>.body} beside it. Every write goes through a temp file and a move, so a crash
 * mid-write leaves the previous index rather than half of one.
 *
 * <p>Every id is checked against {@link StoredAnswer#isValidId} before it is joined onto the
 * directory - an id is a file name here, and this is the adapter where "../" would matter.
 */
@Component
@ConditionalOnProperty(prefix = "alfred.storage.interception", name = "type", havingValue = "file")
public class JsonFileStoredAnswersStoreAdapter implements StoredAnswersStorePort {

    private static final String INDEX = "index.json";

    private final ObjectMapper mapper = new ObjectMapper().setSerializationInclusion(JsonInclude.Include.NON_NULL);
    private final Path dir;

    public JsonFileStoredAnswersStoreAdapter(
            @Value("${INTERCEPTION_ANSWERS_DIR:/appdata/interception-answers}") String dir) {
        this.dir = Path.of(dir);
    }

    @Override
    public synchronized void save(StoredAnswer answer, byte[] body) {
        Path bodyFile = bodyFile(answer.id());
        try {
            Files.createDirectories(dir);
            write(bodyFile, body);
            Map<String, StoredAnswer> index = readIndex();
            index.put(answer.id(), answer);
            write(dir.resolve(INDEX), mapper.writeValueAsBytes(index));
        } catch (IOException e) {
            throw new UncheckedIOException("Could not store answer " + answer.id(), e);
        }
    }

    @Override
    public synchronized Optional<StoredAnswer> findMeta(String id) {
        return StoredAnswer.isValidId(id) ? Optional.ofNullable(readIndex().get(id)) : Optional.empty();
    }

    @Override
    public synchronized Optional<byte[]> findBody(String id) {
        if (!StoredAnswer.isValidId(id) || !readIndex().containsKey(id)) {
            return Optional.empty();
        }
        try {
            return Optional.of(Files.readAllBytes(bodyFile(id)));
        } catch (IOException e) {
            return Optional.empty();
        }
    }

    @Override
    public synchronized List<StoredAnswer> listMeta() {
        return new ArrayList<>(readIndex().values());
    }

    @Override
    public synchronized void delete(String id) {
        if (!StoredAnswer.isValidId(id)) {
            return;
        }
        try {
            Map<String, StoredAnswer> index = readIndex();
            if (index.remove(id) != null) {
                write(dir.resolve(INDEX), mapper.writeValueAsBytes(index));
            }
            Files.deleteIfExists(bodyFile(id));
        } catch (IOException e) {
            throw new UncheckedIOException("Could not delete answer " + id, e);
        }
    }

    private Path bodyFile(String id) {
        if (!StoredAnswer.isValidId(id)) {
            throw new IllegalArgumentException("Not a stored answer id");
        }
        return dir.resolve(id + ".body");
    }

    private Map<String, StoredAnswer> readIndex() {
        Path index = dir.resolve(INDEX);
        if (!Files.exists(index)) {
            return new LinkedHashMap<>();
        }
        try {
            return mapper.readValue(Files.readAllBytes(index), new TypeReference<LinkedHashMap<String, StoredAnswer>>() { });
        } catch (IOException e) {
            throw new UncheckedIOException("Unreadable stored answers index " + index, e);
        }
    }

    private void write(Path target, byte[] content) throws IOException {
        Path temp = Files.createTempFile(dir, ".answer", ".tmp");
        try {
            Files.write(temp, content);
            try {
                Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(temp, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (IOException e) {
            Files.deleteIfExists(temp);
            throw e;
        }
    }
}
