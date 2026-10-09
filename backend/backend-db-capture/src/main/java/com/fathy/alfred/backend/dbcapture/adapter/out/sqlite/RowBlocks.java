package com.fathy.alfred.backend.dbcapture.adapter.out.sqlite;

import io.airlift.compress.zstd.ZstdCompressor;
import io.airlift.compress.zstd.ZstdDecompressor;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;

/**
 * The byte-level pieces of db-capture.db's compact statement storage.
 *
 * <p>Result rows are kept in blocks of {@link #SIZE} rows: block {@code k} of a statement's part holds rows
 * {@code k*SIZE .. k*SIZE+SIZE-1} as one zstd-compressed JSON array (a row the agent never sent is a {@code null}
 * there). One block is one page of the Rows view, so a click decompresses one block - measured on a real capture,
 * a block of 100 rows compresses to about 6% of its JSON.
 *
 * <p>Text that repeats across statements (the SQL, its call stack, where it came from, the result's column list) is
 * stored once in {@code shared_text}, keyed by {@link #hash} of its exact bytes: only identical text is shared.
 */
final class RowBlocks {

    static final int SIZE = 100;

    private RowBlocks() {
    }

    static long blockStart(long rowIndex) {
        return (rowIndex / SIZE) * SIZE;
    }

    static byte[] compress(String json) {
        byte[] raw = json.getBytes(StandardCharsets.UTF_8);
        ZstdCompressor compressor = new ZstdCompressor();
        byte[] out = new byte[compressor.maxCompressedLength(raw.length)];
        int n = compressor.compress(raw, 0, raw.length, out, 0, out.length);
        return Arrays.copyOf(out, n);
    }

    static String decompress(byte[] data, int rawBytes) {
        byte[] out = new byte[rawBytes];
        int n = new ZstdDecompressor().decompress(data, 0, data.length, out, 0, out.length);
        return new String(out, 0, n, StandardCharsets.UTF_8);
    }

    /** The first 16 bytes of SHA-256 - 128 bits, so two different texts never share a key in practice. */
    static byte[] hash(String text) {
        try {
            return Arrays.copyOf(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)), 16);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is missing from this JVM", e);
        }
    }
}
