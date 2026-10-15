package com.fathy.alfred.backend.board.domain.model;

/**
 * A chat's own settings (specs/022 FR-015, FR-023, FR-030): auto-compact after {@code autoN} messages since the last
 * summary (0 = off), the digest after {@code digestGapMin} minutes away, and whether Claude watches calls as they arrive.
 */
public record ChatSettings(ChatKey chat, int autoN, int digestGapMin, boolean watching) {

    public static final int DEFAULT_AUTO_N = 100;
    public static final int MIN_AUTO_N = 20;
    public static final int MAX_AUTO_N = 1000;
    public static final int DEFAULT_DIGEST_GAP_MIN = 30;
    public static final int MIN_DIGEST_GAP_MIN = 5;
    public static final int MAX_DIGEST_GAP_MIN = 600;

    public ChatSettings {
        if (autoN != 0 && (autoN < MIN_AUTO_N || autoN > MAX_AUTO_N)) {
            throw new IllegalArgumentException("Auto-compact is 0 (off) or " + MIN_AUTO_N + "-" + MAX_AUTO_N + " messages");
        }
        if (digestGapMin < MIN_DIGEST_GAP_MIN || digestGapMin > MAX_DIGEST_GAP_MIN) {
            throw new IllegalArgumentException("The digest gap is " + MIN_DIGEST_GAP_MIN + "-" + MAX_DIGEST_GAP_MIN + " minutes");
        }
    }

    public static ChatSettings defaults(ChatKey chat) {
        return new ChatSettings(chat, DEFAULT_AUTO_N, DEFAULT_DIGEST_GAP_MIN, false);
    }
}
