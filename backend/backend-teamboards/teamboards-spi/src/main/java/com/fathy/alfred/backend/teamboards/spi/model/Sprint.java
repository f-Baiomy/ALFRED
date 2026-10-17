package com.fathy.alfred.backend.teamboards.spi.model;

import java.time.Instant;

/** A provider sprint (Azure "Iteration"). */
public record Sprint(String extId, String name, String team, Instant starts, Instant ends) {
}
