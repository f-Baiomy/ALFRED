package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.BoardFilesUseCase;
import com.fathy.alfred.backend.board.application.port.in.SnippetsUseCase.Result;
import com.fathy.alfred.backend.board.application.port.out.BoardFileStorePort;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.BoardFile;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CardChange.Outcome;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Files attached to cards and cycles (specs/017 R36). The type comes from the name's extension and the bytes must match
 * it (a PNG starts as one, text is UTF-8 without NUL bytes) - so nothing is ever served as something else. Every change
 * signals /ws/board {@code files}; no polling.
 */
@Service
public class BoardFilesService implements BoardFilesUseCase {

    private static final Pattern ID = Pattern.compile("^[A-Za-z0-9-]{8,64}$");
    /** A name: no path, no characters a file system or a Content-Disposition header would choke on. */
    private static final Pattern BAD_NAME = Pattern.compile("[\\\\/:*?\"<>|\\p{Cntrl}]");

    private final BoardFileStorePort store;
    private final BoardStorePort cards;
    private final BoardNotificationPort notifications;
    private final Clock clock;

    @Autowired
    public BoardFilesService(BoardFileStorePort store, BoardStorePort cards, BoardNotificationPort notifications) {
        this(store, cards, notifications, Clock.systemUTC());
    }

    BoardFilesService(BoardFileStorePort store, BoardStorePort cards, BoardNotificationPort notifications, Clock clock) {
        this.store = store;
        this.cards = cards;
        this.notifications = notifications;
        this.clock = clock;
    }

    @Override
    public Result<BoardFile> attach(Actor actor, String cardId, String cycleId, String project, String name, byte[] data) {
        Result<Place> where = place(cardId, cycleId, project);
        if (!where.isOk()) {
            return Result.refused(where.outcome(), where.message());
        }
        Place p = where.value();
        String clean = name == null ? "" : name.strip();
        int slash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
        clean = clean.substring(slash + 1);
        if (clean.isEmpty() || clean.length() > BoardFile.MAX_NAME || BAD_NAME.matcher(clean).find()) {
            return Result.refused(Outcome.INVALID, "A file needs a name of at most " + BoardFile.MAX_NAME + " characters, without / \\ : * ? \" < > |");
        }
        String mime = BoardFile.TYPES.get(BoardFile.extension(clean));
        if (mime == null) {
            return Result.refused(Outcome.INVALID, "A file is one of: " + String.join(", ", BoardFile.TYPES.keySet().stream().sorted().toList()));
        }
        if (data == null || data.length == 0) {
            return Result.refused(Outcome.INVALID, "The file is empty");
        }
        if (data.length > BoardFile.MAX_BYTES) {
            return Result.refused(Outcome.INVALID, "A file can be at most 10 MB");
        }
        String problem = content(mime, data);
        if (problem != null) {
            return Result.refused(Outcome.INVALID, problem);
        }
        if (store.listFiles(p.cardId(), p.cardId() == null ? p.cycleId() : null).size() >= BoardFile.MAX_PER_OWNER) {
            return Result.refused(Outcome.INVALID, "At most " + BoardFile.MAX_PER_OWNER + " files in one place - remove one first");
        }
        BoardFile file = new BoardFile(UUID.randomUUID().toString(), p.project(), p.cardId(), p.cycleId(), clean, mime, data.length, data,
                actor, clock.instant());
        store.saveFile(file);
        notifications.changed(p.project(), p.cycleId(), p.cardId(), "files");
        return Result.ok(file.withoutData());
    }

    @Override
    public Result<List<BoardFile>> files(String cardId, String cycleId) {
        boolean card = cardId != null && !cardId.isBlank();
        boolean cycle = cycleId != null && !cycleId.isBlank();
        if (card == cycle) {
            return Result.refused(Outcome.INVALID, "Name a card or a cycle");
        }
        return Result.ok(store.listFiles(card ? cardId : null, card ? null : cycleId));
    }

    @Override
    public Optional<BoardFile> file(String id) {
        return id == null || !ID.matcher(id).matches() ? Optional.empty() : store.findFile(id);
    }

    @Override
    public Result<Void> remove(Actor actor, String id) {
        Optional<BoardFile> f = file(id);
        if (f.isEmpty()) {
            return Result.refused(Outcome.NOT_FOUND, "No such file");
        }
        if (actor == Actor.CLAUDE && f.get().author() != Actor.CLAUDE) {
            return Result.refused(Outcome.REFUSED_FOR_CLAUDE, "Claude removes only the files it attached");
        }
        store.deleteFile(id);
        notifications.changed(f.get().project(), f.get().cycleId(), f.get().cardId(), "files");
        return Result.ok(null);
    }

    private record Place(String project, String cardId, String cycleId) {
    }

    private Result<Place> place(String cardId, String cycleId, String project) {
        boolean card = cardId != null && !cardId.isBlank();
        boolean cycle = cycleId != null && !cycleId.isBlank();
        if (card == cycle) {
            return Result.refused(Outcome.INVALID, "A file goes on a card or on a cycle");
        }
        if (card) {
            Optional<Card> c = cards.find(cardId.strip());
            return c.map(x -> Result.ok(new Place(x.project(), x.id(), x.cycleId()))).orElseGet(() -> Result.refused(Outcome.NOT_FOUND, "No such card"));
        }
        if (!ID.matcher(cycleId.strip()).matches()) {
            return Result.refused(Outcome.INVALID, "Not a cycle id");
        }
        return project == null ? Result.refused(Outcome.INVALID, "A cycle's file needs its project")
                : Result.ok(new Place(project.strip(), null, cycleId.strip()));
    }

    /** Why the bytes are not what the name says, or null. */
    static String content(String mime, byte[] data) {
        return switch (mime) {
            case "image/png", "image/jpeg" -> BoardImagesService.looksLike(mime, data) ? null : "The file is not a " + (mime.endsWith("png") ? "PNG" : "JPEG") + " picture";
            case "application/pdf" -> data.length > 4 && data[0] == '%' && data[1] == 'P' && data[2] == 'D' && data[3] == 'F' ? null : "The file is not a PDF";
            default -> isText(data) ? null : "The file is not text (UTF-8)";
        };
    }

    private static boolean isText(byte[] data) {
        for (byte b : data) {
            if (b == 0) {
                return false;
            }
        }
        try {
            StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(data));
            return true;
        } catch (CharacterCodingException e) {
            return false;
        }
    }
}
