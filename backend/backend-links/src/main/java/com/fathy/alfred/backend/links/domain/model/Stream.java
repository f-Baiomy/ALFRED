package com.fathy.alfred.backend.links.domain.model;

import java.time.Instant;

/**
 * A stream (D5-D8): an owner lets the Alfred at the other end of a link read one cycle or one board live. {@code mine} is
 * true on the owner; the reader keeps a copy of the row (names only, never data - D20) so it can show the stream while
 * the owner is offline (D21). {@code env} and {@code forBoard} mark a test cycle an environment Alfred recorded for the
 * host's board (D38): the board id is the host's own.
 */
public record Stream(String id, boolean mine, String linkId, StreamKind kind, String target, String targetName, String project,
                     StreamMode mode, boolean autoAccept, boolean passOn, StreamMode passMode, boolean unmasked, String env,
                     String forBoard, Instant createdAt, Instant endedAt) {

    public boolean active() {
        return endedAt == null;
    }

    public Stream ended(Instant at) {
        return new Stream(id, mine, linkId, kind, target, targetName, project, mode, autoAccept, passOn, passMode, unmasked, env, forBoard,
                createdAt, at);
    }

    public Stream with(StreamMode newMode, boolean newAuto, boolean newPassOn, StreamMode newPassMode, boolean newUnmasked) {
        return new Stream(id, mine, linkId, kind, target, targetName, project, newMode, newAuto, newPassOn, newPassMode, newUnmasked, env,
                forBoard, createdAt, endedAt);
    }

    public Stream named(String newName, String newProject) {
        return new Stream(id, mine, linkId, kind, target, newName, newProject == null ? project : newProject, mode, autoAccept, passOn,
                passMode, unmasked, env, forBoard, createdAt, endedAt);
    }

    /** The mode a reader has: the stream's own for the Alfred it was given to, the pass-on mode beyond it (D8). */
    public StreamMode modeFor(int hop) {
        return hop <= 1 ? mode : passMode;
    }
}
