package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.domain.model.ActivityKind;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.BoardChanges;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;

/**
 * "While you were away" (specs/022 FR-023): what changed on the board since the user last looked at a chat, one line per
 * card and per cycle part, built from the board's own history - no model. Card lines mention the card, so they open it.
 */
final class ChatDigest {

    static final int MAX_LINES = 30;

    private ChatDigest() {
    }

    static List<String> lines(List<BoardChanges.Entry> entries, List<BoardChanges.CycleChange> cycles) {
        Map<String, Card> cards = new LinkedHashMap<>();
        for (BoardChanges.Entry e : entries) {
            Card c = cards.computeIfAbsent(e.project() + "#" + e.number(), k -> new Card(e.project(), e.number(), e.title()));
            c.status = e.status() == null ? c.status : e.status().name();
            String what = what(e);
            if (what != null) {
                c.what.merge(what, 1, Integer::sum);
            }
        }
        List<String> out = new ArrayList<>();
        for (Card c : cards.values()) {
            if (c.what.isEmpty()) {
                continue;
            }
            List<String> parts = new ArrayList<>();
            c.what.forEach((w, n) -> parts.add(n > 1 ? w + " ×" + n : w));
            out.add("- @[card:" + c.project + "#" + c.number + "|" + label(c.title) + "] - " + String.join(", ", parts)
                    + (c.status == null ? "" : " · now " + c.status.toLowerCase(Locale.ROOT).replace('_', ' ')));
        }
        Map<String, Integer> parts = new TreeMap<>();
        for (BoardChanges.CycleChange x : cycles) {
            String name = switch (x.what()) {
                case "brief" -> "the brief changed";
                case "spec" -> "spec file " + x.name() + " changed";
                case "mark" -> "checklist marks";
                case "suggestion" -> "Claude suggested checklist marks";
                default -> x.what();
            };
            parts.merge(name, 1, Integer::sum);
        }
        parts.forEach((w, n) -> out.add("- " + (n > 1 && (w.endsWith("marks")) ? w + " ×" + n : w)));
        if (out.size() > MAX_LINES) {
            int more = out.size() - MAX_LINES;
            List<String> cut = new ArrayList<>(out.subList(0, MAX_LINES));
            cut.add("- … and " + more + " more (Board → Changes)");
            return cut;
        }
        return out;
    }

    private static String what(BoardChanges.Entry e) {
        boolean claude = e.entry().actor() == Actor.CLAUDE;
        ActivityKind k = e.entry().kind();
        return switch (k) {
            case CREATED -> claude ? "Claude added it" : "added";
            case COMMENT -> claude ? "Claude commented" : "you commented";
            case STATUS -> (claude ? "Claude moved it" : "moved") + (e.entry().newValue() == null ? ""
                    : " to " + e.entry().newValue().toLowerCase(Locale.ROOT).replace('_', ' '));
            case PROPOSED -> "Claude proposes " + (e.entry().newValue() == null ? "a change" : e.entry().newValue().toLowerCase(Locale.ROOT));
            case RESOLUTION, REOPENED -> claude ? null : k == ActivityKind.REOPENED ? "reopened" : "closed";
            case DESCRIPTION, TITLE -> claude ? "Claude edited it" : "edited";
            default -> null;
        };
    }

    private static String label(String title) {
        String t = title == null ? "" : title.replace("|", "/").replace("]", ")").strip();
        return t.length() > 60 ? t.substring(0, 59) + "…" : t;
    }

    private static final class Card {
        final String project;
        final int number;
        final String title;
        String status;
        final Map<String, Integer> what = new LinkedHashMap<>();

        Card(String project, int number, String title) {
            this.project = project;
            this.number = number;
            this.title = title;
        }
    }
}
