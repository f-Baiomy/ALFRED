package com.fathy.alfred.backend.dbcapture.adapter.in.web;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;

/**
 * The key the reverse proxy stamps into X-Alfred-Call ({@code key=<issued>.<hmac>}, proxy/log_and_route_reverse.py
 * {@code agent_key}) and the agent presents as {@code X-Alfred-Agent-Key}: HMAC-SHA256 of {@code "agent:<issued>"}
 * under the webhook secret, where {@code issued} is the epoch second of the hour it was made. It lets an agent that
 * was loaded with a wrong or missing secret still report to the Alfred whose proxy delivers its calls, without the
 * secret ever travelling to the application. A key is accepted for {@link #VALID_SECONDS} from its issue hour.
 */
final class AgentKey {

    static final long VALID_SECONDS = 24 * 3600;
    /** Tolerance for a proxy whose clock runs ahead of the backend's. */
    static final long FUTURE_SECONDS = 300;

    private AgentKey() {
    }

    static boolean valid(String secret, String key, Instant now) {
        if (secret == null || secret.isBlank() || key == null) {
            return false;
        }
        int dot = key.indexOf('.');
        if (dot <= 0 || dot == key.length() - 1) {
            return false;
        }
        long issued;
        try {
            issued = Long.parseLong(key.substring(0, dot));
        } catch (NumberFormatException e) {
            return false;
        }
        long nowSeconds = now.getEpochSecond();
        if (issued > nowSeconds + FUTURE_SECONDS || nowSeconds - issued > VALID_SECONDS) {
            return false;
        }
        byte[] expected = expected(secret, issued).getBytes(StandardCharsets.UTF_8);
        byte[] given = key.substring(dot + 1).toLowerCase(java.util.Locale.ROOT).getBytes(StandardCharsets.UTF_8);
        return MessageDigest.isEqual(expected, given);
    }

    static String expected(String secret, long issued) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return HexFormat.of().formatHex(mac.doFinal(("agent:" + issued).getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    /** What the proxy would stamp now - for tests and tools. */
    static String make(String secret, Instant now) {
        long issued = now.getEpochSecond() / 3600 * 3600;
        return issued + "." + expected(secret, issued);
    }
}
