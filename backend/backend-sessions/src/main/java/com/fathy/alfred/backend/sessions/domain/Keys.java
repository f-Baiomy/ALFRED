package com.fathy.alfred.backend.sessions.domain;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Optional;

/**
 * Keys as sent in {@code X-Alfred-Key}: {@code ak_<keyId>.<secret>} - the id to find the key, 32 random bytes as the
 * secret. Only a SHA-256 of the secret is kept: the secret is random, so no slow hash is needed. Compared in constant time.
 */
public final class Keys {

    public static final String HEADER = "X-Alfred-Key";
    private static final String PREFIX = "ak_";
    private static final SecureRandom RANDOM = new SecureRandom();

    private Keys() {
    }

    public record Parsed(String keyId, String secret) {
    }

    public record New(String keyId, String key, String hash) {
    }

    public static New generate() {
        byte[] id = new byte[8];
        byte[] secret = new byte[32];
        RANDOM.nextBytes(id);
        RANDOM.nextBytes(secret);
        String keyId = HexFormat.of().formatHex(id);
        String s = Base64.getUrlEncoder().withoutPadding().encodeToString(secret);
        return new New(keyId, PREFIX + keyId + "." + s, hash(s));
    }

    public static Optional<Parsed> parse(String raw) {
        if (raw == null) {
            return Optional.empty();
        }
        String v = raw.strip();
        int dot = v.indexOf('.');
        if (!v.startsWith(PREFIX) || dot <= PREFIX.length() || dot == v.length() - 1 || v.length() > 200) {
            return Optional.empty();
        }
        String keyId = v.substring(PREFIX.length(), dot);
        if (!keyId.matches("[0-9a-f]{16}")) {
            return Optional.empty();
        }
        return Optional.of(new Parsed(keyId, v.substring(dot + 1)));
    }

    public static String hash(String secret) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(secret.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    public static boolean matches(String secret, String storedHash) {
        if (secret == null || storedHash == null) {
            return false;
        }
        return MessageDigest.isEqual(hash(secret).getBytes(StandardCharsets.US_ASCII), storedHash.getBytes(StandardCharsets.US_ASCII));
    }

    /** A one-time random token (connect links): 32 bytes, URL-safe. */
    public static String token() {
        byte[] b = new byte[32];
        RANDOM.nextBytes(b);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    /** A six-digit pairing code. */
    public static String pairCode() {
        return String.format("%06d", RANDOM.nextInt(1_000_000));
    }

    /** A user as stored: the email, trimmed and lower-cased. */
    public static String user(String email) {
        return email == null ? "" : email.strip().toLowerCase(java.util.Locale.ROOT);
    }
}
