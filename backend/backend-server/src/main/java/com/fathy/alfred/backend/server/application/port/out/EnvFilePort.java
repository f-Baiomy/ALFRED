package com.fathy.alfred.backend.server.application.port.out;

import com.fathy.alfred.backend.server.domain.model.EnvDocument;

/** The install's .env file: the one source of a native install's deploy-time settings. */
public interface EnvFilePort {

    boolean exists();

    /** The file as it is now; an empty document when it does not exist yet. */
    EnvDocument read();

    /**
     * Replaces the file with {@code document}, atomically (FR-015), but only if the file still has the content hash the
     * document was read with ({@code expectedHash}); otherwise nothing is written (FR-036).
     *
     * @throws EnvConflictException the file changed underneath the editor
     */
    void write(EnvDocument document, String expectedHash);

    /** Where the file is, for messages ("Saving writes to /opt/alfred/.env"). */
    String location();
}
