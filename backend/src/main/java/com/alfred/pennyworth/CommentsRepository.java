package com.alfred.pennyworth;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Repository;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * Comments are flagged issues on a specific line of a call's request/
 * response, for the support-team export workflow. Persisted as a flat JSON
 * file rather than a database - this app has no database anywhere else
 * either, and comment volume is small (one team, ad-hoc annotations).
 */
@Repository
public class CommentsRepository {

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Value("${COMMENTS_FILE:/appdata/comments.json}")
    private String commentsFile;

    public synchronized List<CommentDto> findByCallId(String callId) {
        return readAll().stream()
                .filter(c -> c.callId().equals(callId))
                .collect(Collectors.toList());
    }

    public synchronized CommentDto create(CommentRequestDto request) {
        List<CommentDto> all = readAll();
        CommentDto created = new CommentDto(
                UUID.randomUUID().toString(),
                request.callId(),
                request.block(),
                request.lineIndex(),
                request.lineText(),
                request.comment(),
                Instant.now().toString()
        );
        all.add(created);
        writeAll(all);
        return created;
    }

    public synchronized boolean deleteById(String id) {
        List<CommentDto> all = readAll();
        boolean removed = all.removeIf(c -> c.id().equals(id));
        if (removed) {
            writeAll(all);
        }
        return removed;
    }

    private List<CommentDto> readAll() {
        Path path = Path.of(commentsFile);
        if (!Files.exists(path)) {
            return new ArrayList<>();
        }
        try {
            CommentDto[] parsed = objectMapper.readValue(Files.readString(path), CommentDto[].class);
            return new ArrayList<>(List.of(parsed));
        } catch (IOException e) {
            return new ArrayList<>();
        }
    }

    private void writeAll(List<CommentDto> comments) {
        try {
            Path path = Path.of(commentsFile);
            if (path.getParent() != null) {
                Files.createDirectories(path.getParent());
            }
            Files.writeString(path, objectMapper.writeValueAsString(comments));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
