package com.fathy.alfred.backend.links.domain;

import java.text.Normalizer;
import java.util.Collection;
import java.util.Locale;

/** Turns the name a link is given into its slug: the part refs carry, fixed for good once the link is made (D2). */
public final class Slugs {

    public static final int MAX = 24;

    private Slugs() {
    }

    public static String of(String name, Collection<String> taken) {
        String base = Normalizer.normalize(name == null ? "" : name, Normalizer.Form.NFKD)
                .replaceAll("\\p{M}+", "")
                .toLowerCase(Locale.ROOT)
                .replaceAll("[^a-z0-9]+", "-")
                .replaceAll("^-+|-+$", "");
        if (base.isEmpty()) {
            base = "alfred";
        }
        if (base.length() > MAX) {
            base = base.substring(0, MAX).replaceAll("-+$", "");
        }
        String slug = base;
        for (int n = 2; taken.contains(slug); n++) {
            String suffix = "-" + n;
            String head = base.length() + suffix.length() > MAX ? base.substring(0, MAX - suffix.length()).replaceAll("-+$", "") : base;
            slug = head + suffix;
        }
        return slug;
    }
}
