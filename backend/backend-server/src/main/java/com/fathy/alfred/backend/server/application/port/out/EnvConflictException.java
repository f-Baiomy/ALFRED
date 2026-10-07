package com.fathy.alfred.backend.server.application.port.out;

/** .env changed after the editor read it: the save is refused so neither edit is lost (FR-036). */
public class EnvConflictException extends RuntimeException {

    private final String currentHash;

    public EnvConflictException(String currentHash) {
        super(".env was changed on the server after it was loaded");
        this.currentHash = currentHash;
    }

    public String currentHash() {
        return currentHash;
    }
}
