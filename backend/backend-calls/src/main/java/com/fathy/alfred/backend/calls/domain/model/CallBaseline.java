package com.fathy.alfred.backend.calls.domain.model;

/**
 * How one endpoint normally performs, so a single call's duration can be judged rather than just
 * read. "26.72s" means nothing on its own; "26.72s against a p50 of 3.4s over 154 calls" is a
 * finding, and "26.72s against a p50 of 24s" says the endpoint is simply always slow.
 *
 * <p>Scoped to an exact {@code url} - the same path against two different suppliers are genuinely
 * different endpoints with different expected timings, so they must not be averaged together.
 *
 * <p>{@code sampleSize} is part of the answer, not metadata: a p50 over three calls is not a
 * baseline, and the caller needs to know that before drawing a conclusion from it.
 */
public record CallBaseline(String url, int sampleSize, Double p50Ms, Double p95Ms) {

    /** Nothing comparable on record yet - the caller should say so rather than show a percentile of one. */
    public static CallBaseline empty(String url) {
        return new CallBaseline(url, 0, null, null);
    }
}
