package com.fathy.alfred.backend.logs.domain.ingest;

import java.util.ArrayList;
import java.util.List;

/**
 * The one implementation of the grouped view's placement rule (spec FR-022, data-model.md):
 * a line's level is how many of the ordered level IDs it carries; its parent is the line one level
 * up with the same leading IDs. A line that skips a level (A and C, no B) hangs under its nearest
 * present ancestor with {@code missingLevel} set; a line without the first ID goes to the bucket
 * (level 0).
 */
public final class GroupKeyer {

    /** Separates IDs inside a group path; cannot occur in JSON text an ID was taken from. */
    public static final char SEP = '\u0001';

    private GroupKeyer() {
    }

    /**
     * @param level        1..n, or 0 for the "no first ID" bucket
     * @param path         the IDs of this line's node joined by {@link #SEP} ("" for the bucket)
     * @param missingLevel index (0-based) of the first skipped level, or -1
     */
    public record Placement(int level, String path, int missingLevel) {

        public static final Placement BUCKET = new Placement(0, "", -1);

        public String parentPath() {
            int i = path.lastIndexOf(SEP);
            return i < 0 ? "" : path.substring(0, i);
        }
    }

    public static Placement place(List<String> ids) {
        if (ids.isEmpty() || isBlank(ids.get(0))) {
            return Placement.BUCKET;
        }
        int deepest = -1;
        for (int i = 0; i < ids.size(); i++) {
            if (!isBlank(ids.get(i))) {
                deepest = i;
            }
        }
        List<String> present = new ArrayList<>();
        for (int i = 0; i <= deepest; i++) {
            if (isBlank(ids.get(i))) {
                return new Placement(i, String.join(String.valueOf(SEP), present), i);
            }
            present.add(ids.get(i));
        }
        return new Placement(present.size(), String.join(String.valueOf(SEP), present), -1);
    }

    /** Every ancestor path of a node, shortest first, including the node itself. */
    public static List<String> ancestorsAndSelf(String path) {
        List<String> out = new ArrayList<>();
        if (path.isEmpty()) {
            return out;
        }
        int i = -1;
        while ((i = path.indexOf(SEP, i + 1)) >= 0) {
            out.add(path.substring(0, i));
        }
        out.add(path);
        return out;
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }
}
