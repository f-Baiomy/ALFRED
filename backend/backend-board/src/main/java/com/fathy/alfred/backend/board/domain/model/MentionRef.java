package com.fathy.alfred.backend.board.domain.model;

import java.util.Locale;

/** One reference in text or in a card's Linked list: {@code @[type:ref|label]} (contracts/mention-syntax.md). The label is
 *  the one-line summary shown when the item is gone. */
public record MentionRef(MentionType type, String ref, String label) {

    public String typeName() {
        return type.name().toLowerCase(Locale.ROOT);
    }

    /** The live call id of a {@code call} mention ({@code in:<id>} / {@code out:<id>}), or null for a captured cycle call
     *  ({@code ...@<cycleId>}) and for every other type - only live calls need keeping out of retention. */
    public String liveCallId() {
        if (type != MentionType.CALL || ref.contains("@")) {
            return null;
        }
        int colon = ref.indexOf(':');
        return colon < 0 ? null : ref.substring(colon + 1);
    }

    /** The call id of a {@code call} mention, live or captured; null otherwise. */
    public String callId() {
        if (type != MentionType.CALL) {
            return null;
        }
        int colon = ref.indexOf(':');
        if (colon < 0) {
            return null;
        }
        int at = ref.indexOf('@', colon);
        return at < 0 ? ref.substring(colon + 1) : ref.substring(colon + 1, at);
    }

    /** "in"/"out" of a call mention; null otherwise. */
    public String direction() {
        if (type != MentionType.CALL) {
            return null;
        }
        int colon = ref.indexOf(':');
        return colon < 0 ? null : ref.substring(0, colon);
    }

    /** The cycle the item lives in, when its ref names one: a captured call's {@code @cycle}, or the first part of a
     *  spec/spacer ref, or a cycle mention itself. */
    public String cycleId() {
        return switch (type) {
            case CALL -> ref.contains("@") ? ref.substring(ref.indexOf('@') + 1) : null;
            case SPEC, SPACER -> ref.contains("/") ? ref.substring(0, ref.indexOf('/')) : null;
            case CYCLE -> ref;
            default -> null;
        };
    }
}
