package com.fathy.alfred.backend.teamboards.spi.model;

/**
 * The user's personal access token, passed per call and never kept in a field (contracts/connector-spi.md). Its
 * {@code toString()} is masked so a log line or an exception message can never print it.
 */
public record Token(String value) {

    public boolean blank() {
        return value == null || value.isBlank();
    }

    @Override
    public String toString() {
        return "Token[***]";
    }
}
