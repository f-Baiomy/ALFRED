package com.fathy.alfred.backend.board.domain;

import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.Flag;

import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * One quick-add line to a card: {@code bug! discount not saved #urgent}. Rules and cases in
 * specs/014-task-board/vectors/quick-add.json, shared with quick-add-parser.ts.
 */
public final class QuickAddParser {

    /** {@code title} is null when nothing is left once prefix and flags are removed. */
    public record Parsed(CardKind kind, String title, Set<Flag> flags) {
    }

    private static final Map<String, CardKind> PREFIXES = Map.of("bug!", CardKind.BUG, "task!", CardKind.TASK, "note!", CardKind.NOTE);
    private static final Map<String, Flag> FLAGS = Map.of("#urgent", Flag.URGENT, "#risk", Flag.RISK, "#blocker", Flag.BLOCKER,
            "#impact", Flag.AFFECTS_PROJECT, "#decision", Flag.NEEDS_DECISION);

    private QuickAddParser() {
    }

    public static Parsed parse(String line) {
        String rest = line == null ? "" : line.strip();
        CardKind kind = CardKind.TASK;
        String lower = rest.toLowerCase(Locale.ROOT);
        for (Map.Entry<String, CardKind> p : PREFIXES.entrySet()) {
            if (lower.startsWith(p.getKey())) {
                kind = p.getValue();
                rest = rest.substring(p.getKey().length());
                break;
            }
        }
        if (kind == CardKind.TASK && rest.startsWith("?") && !lower.startsWith("task!")) {
            kind = CardKind.QUESTION;
            rest = rest.substring(1);
        }
        EnumSet<Flag> flags = EnumSet.noneOf(Flag.class);
        List<String> words = new ArrayList<>();
        for (String word : rest.strip().split("\\s+")) {
            if (word.isEmpty()) {
                continue;
            }
            Flag flag = FLAGS.get(word.toLowerCase(Locale.ROOT));
            if (flag != null) {
                flags.add(flag);
            } else {
                words.add(word);
            }
        }
        String title = String.join(" ", words);
        return new Parsed(kind, title.isEmpty() ? null : title, Set.copyOf(flags));
    }
}
