package com.fathy.alfred.backend.links.domain.model;

import java.time.Instant;

/** The owner's read log (D31): what a linked Alfred read, counted per day per thing read. {@code via} names a middle hop. */
public record ReadEntry(String linkId, String family, String target, String day, long count, Instant firstAt, Instant lastAt, String via) {
}
