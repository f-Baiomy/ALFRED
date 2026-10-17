package com.fathy.alfred.backend.teamboards.spi.model;

/** What a connector adds to a board's seed beyond the neutral fields, e.g. Azure's Repro Steps HTML as steps. */
public record SeedPart(String purpose, String steps, String acceptance, String context) {
}
