package com.fathy.alfred.backend.teamboards.spi.model;

/** One field's change in a revision. */
public record FieldChange(String field, String from, String to) {
}
