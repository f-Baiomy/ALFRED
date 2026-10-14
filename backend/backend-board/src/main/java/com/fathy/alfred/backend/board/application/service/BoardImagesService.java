package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.BoardImagesUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardImageStorePort;
import com.fathy.alfred.backend.board.domain.model.BoardImage;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.util.Optional;
import java.util.UUID;

/**
 * Pictures in board texts (docs/board.md "Rich text"). A picture belongs to the card or cycle whose text first shows it
 * (BoardService / CycleBriefService attach it on save) and goes with that card; one that no text ever showed - pasted,
 * then the text was not saved - is removed a day later, swept when the next picture arrives (no timer).
 */
@Service
public class BoardImagesService implements BoardImagesUseCase {

    static final Duration UNATTACHED = Duration.ofDays(1);

    private final BoardImageStorePort store;
    private final Clock clock;

    @Autowired
    public BoardImagesService(BoardImageStorePort store) {
        this(store, Clock.systemUTC());
    }

    BoardImagesService(BoardImageStorePort store, Clock clock) {
        this.store = store;
        this.clock = clock;
    }

    @Override
    public Saved save(String mime, byte[] data) {
        String type = mime == null ? "" : mime.split(";")[0].strip().toLowerCase(java.util.Locale.ROOT);
        if (!TYPES.contains(type)) {
            return new Saved(null, "A picture is PNG, JPEG, GIF or WebP");
        }
        if (data == null || data.length == 0) {
            return new Saved(null, "The picture is empty");
        }
        if (data.length > BoardImage.MAX_BYTES) {
            return new Saved(null, "A picture can be at most 5 MB");
        }
        if (!looksLike(type, data)) {
            return new Saved(null, "The file is not a " + type.substring(6).toUpperCase(java.util.Locale.ROOT) + " picture");
        }
        store.deleteUnattachedImages(clock.instant().minus(UNATTACHED));
        String id = UUID.randomUUID().toString();
        store.saveImage(new BoardImage(id, type, data, null, null, clock.instant()));
        return new Saved(id, null);
    }

    @Override
    public Optional<BoardImage> image(String id) {
        return id == null || !id.matches("^[A-Za-z0-9-]{8,64}$") ? Optional.empty() : store.findImage(id);
    }

    /** The bytes start as the type says - so nothing else is ever served as a picture. */
    static boolean looksLike(String type, byte[] d) {
        return switch (type) {
            case "image/png" -> d.length > 8 && (d[0] & 0xff) == 0x89 && d[1] == 'P' && d[2] == 'N' && d[3] == 'G';
            case "image/jpeg" -> d.length > 3 && (d[0] & 0xff) == 0xFF && (d[1] & 0xff) == 0xD8;
            case "image/gif" -> d.length > 6 && d[0] == 'G' && d[1] == 'I' && d[2] == 'F';
            case "image/webp" -> d.length > 12 && d[0] == 'R' && d[1] == 'I' && d[2] == 'F' && d[3] == 'F' && d[8] == 'W' && d[9] == 'E'
                    && d[10] == 'B' && d[11] == 'P';
            default -> false;
        };
    }
}
