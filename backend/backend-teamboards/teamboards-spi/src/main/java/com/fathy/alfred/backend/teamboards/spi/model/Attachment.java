package com.fathy.alfred.backend.teamboards.spi.model;

import java.net.URI;

/** A file attached to a work item. {@code data} is null when it was only listed (too big, or not downloaded). */
public record Attachment(String name, String mime, long size, URI url, byte[] data) {

    public static final long MAX_BYTES = 10L * 1024 * 1024;
    public static final long MAX_PER_ITEM = 50L * 1024 * 1024;

    @Override
    public String toString() {
        return "Attachment[" + name + ", " + size + " bytes]";
    }
}
