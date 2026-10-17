package com.fathy.alfred.backend.teamboards.spi.model;

import java.time.Instant;

/** A comment on a work item (HTML as the provider keeps it). */
public record Comment(String id, String by, Instant at, String text) {
}
