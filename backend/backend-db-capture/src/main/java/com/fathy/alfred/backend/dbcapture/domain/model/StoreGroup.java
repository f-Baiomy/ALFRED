package com.fathy.alfred.backend.dbcapture.domain.model;

/**
 * A transaction (MULTI … EXEC, {@code kind} "tx") or pipeline ("pipeline") a command was sent in: the group's id
 * (unique within its agent), this command's place in it and the group's size - one round trip for all of them.
 */
public record StoreGroup(String kind, String id, int index, int size) {
}
