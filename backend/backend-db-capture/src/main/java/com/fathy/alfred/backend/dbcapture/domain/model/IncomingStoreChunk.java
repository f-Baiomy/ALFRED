package com.fathy.alfred.backend.dbcapture.domain.model;

/** One part of a big command's bytes: {@code which} is "args", "reply" or "before"; parts are 0..of-1. */
public record IncomingStoreChunk(String sid, String which, int part, int of, byte[] data) {
}
