package com.fathy.alfred.backend.links.domain;

import java.util.Optional;
import java.util.regex.Pattern;

/**
 * A ref to something another Alfred holds (R1): its own id there, then {@code @<slug>} of the link it is reached through
 * - {@code 8f1c…@stg83}. A ref read through a second link gets a second suffix ({@code 8f1c…@stg83@pc-1}); the outermost
 * one is the link to use here, the rest is for the next Alfred. A slug is lower-case letters, digits and '-', so an
 * e-mail address ({@code a@gmail.com}) is never a ref, and only a slug of a known link is ever treated as one.
 */
public final class RemoteRef {

    public static final Pattern SLUG = Pattern.compile("[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?");

    /** The outermost link of a ref and what is left for the Alfred at its other end. */
    public record Split(String inner, String slug) {
    }

    private RemoteRef() {
    }

    public static Optional<Split> outer(String value) {
        if (value == null) {
            return Optional.empty();
        }
        int at = value.lastIndexOf('@');
        if (at <= 0 || at == value.length() - 1) {
            return Optional.empty();
        }
        String slug = value.substring(at + 1);
        if (!SLUG.matcher(slug).matches()) {
            return Optional.empty();
        }
        return Optional.of(new Split(value.substring(0, at), slug));
    }

    public static String append(String value, String slug) {
        return value + "@" + slug;
    }

    /** The id with every link suffix taken off: what the owner itself calls it. */
    public static String local(String value) {
        String v = value;
        Optional<Split> s;
        while ((s = outer(v)).isPresent()) {
            v = s.get().inner();
        }
        return v;
    }

    /** How many links a ref goes through (0 for a local id). */
    public static int hops(String value) {
        int n = 0;
        String v = value;
        Optional<Split> s;
        while ((s = outer(v)).isPresent()) {
            v = s.get().inner();
            n++;
        }
        return n;
    }
}
