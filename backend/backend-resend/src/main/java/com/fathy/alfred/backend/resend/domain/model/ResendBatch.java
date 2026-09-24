package com.fathy.alfred.backend.resend.domain.model;

/**
 * Marks a resend as one of several sent together (e.g. "resend these N calls"), so every resent
 * call's log entry can say which batch it belongs to and where in it it sits.
 *
 * @param id    caller-chosen batch id, shared by every call of the batch.
 * @param index 1-based position of this call within the batch.
 * @param total how many calls the batch has.
 */
public record ResendBatch(String id, int index, int total) {
}
