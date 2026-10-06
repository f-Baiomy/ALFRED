package com.fathy.alfred.backend.dbcapture.domain;

/**
 * A text that stops a regex match once its deadline has passed: {@code java.util.regex} has no timeout, and a
 * catastrophic pattern ({@code (a+)+$}) over a long line would otherwise hold a backend thread for minutes. Every
 * {@link #charAt} checks the clock (cheaply - every 1,024 reads) and throws {@link Expired}.
 */
public final class DeadlineCharSequence implements CharSequence {

    /** The deadline passed while matching. */
    public static final class Expired extends RuntimeException {
        public Expired() {
            super("pattern search ran out of time", null, false, false);
        }
    }

    private final CharSequence text;
    private final long deadlineNanos;
    private int reads;

    public DeadlineCharSequence(CharSequence text, long deadlineNanos) {
        this.text = text;
        this.deadlineNanos = deadlineNanos;
    }

    @Override
    public char charAt(int index) {
        if ((++reads & 1023) == 0 && System.nanoTime() > deadlineNanos) {
            throw new Expired();
        }
        return text.charAt(index);
    }

    @Override
    public int length() {
        return text.length();
    }

    @Override
    public CharSequence subSequence(int start, int end) {
        return new DeadlineCharSequence(text.subSequence(start, end), deadlineNanos);
    }

    @Override
    public String toString() {
        return text.toString();
    }
}
