package com.fathy.alfred.backend.links.domain;

import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HexFormat;

/** The link's proof (R4): HMAC-SHA256 of a fresh nonce with the shared secret, compared in constant time. */
public final class Mac {

    private static final SecureRandom RANDOM = new SecureRandom();

    private Mac() {
    }

    public static String of(String secret, String message) {
        try {
            javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return HexFormat.of().formatHex(mac.doFinal(message.getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HmacSHA256 is not available", e);
        }
    }

    public static boolean same(String a, String b) {
        if (a == null || b == null) {
            return false;
        }
        return MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }

    /** {@code bytes} random bytes as hex. */
    public static String random(int bytes) {
        byte[] b = new byte[bytes];
        RANDOM.nextBytes(b);
        return HexFormat.of().formatHex(b);
    }

    /** A six-digit code shown as "123 456". */
    public static String code() {
        int n = 100_000 + RANDOM.nextInt(900_000);
        String s = Integer.toString(n);
        return s.substring(0, 3) + " " + s.substring(3);
    }
}
