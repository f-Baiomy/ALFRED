package com.fathy.alfred.backend.dbcapture.domain.model;

/** A recorded call's method, path and status - from the calls slices, for "written by" and key history. */
public record CallMetadata(String method, String path, Integer status) {
}
