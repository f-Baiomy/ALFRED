package com.fathy.alfred.backend.teamboards.spi.model;

/**
 * One item of a main item's tree (specs/028 R5): {@code relation} ANCESTOR, DESCENDANT or LINK; {@code depth} 0 for the
 * root, below 0 above it; {@code parent} the item it hangs under; {@code linkKind} for a LINK (Related, Duplicate...).
 */
public record TreeRef(String id, String relation, int depth, String parent, String linkKind) {

    public static final String ANCESTOR = "ANCESTOR";
    public static final String DESCENDANT = "DESCENDANT";
    public static final String LINK = "LINK";
}
