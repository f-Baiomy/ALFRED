package com.fathy.alfred.backend.logs.domain.ingest;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/**
 * A file fingerprint: {@code <sha256 of the first MB>:<size>}. The head hash says "same file"
 * (stable while a followed file grows); the size makes a re-load of an identical finished file
 * recognisable before loading it twice (clarification 2026-10-03). The browser computes the same
 * value for uploads, so both sides compare equal.
 */
public final class Fingerprints {

    public static final int HEAD_BYTES = 1 << 20;

    private Fingerprints() {
    }

    public static String of(Path file) throws IOException {
        long size = Files.size(file);
        try (InputStream in = Files.newInputStream(file)) {
            return head(in.readNBytes(HEAD_BYTES)) + ":" + size;
        }
    }

    public static String head(byte[] firstBytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(firstBytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Same file start, regardless of how much it has grown. */
    public static boolean sameHead(String a, String b) {
        return a != null && b != null && a.split(":")[0].equals(b.split(":")[0]);
    }
}
