package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.List;

/**
 * How a board names the cycles it records (specs/033) - the one place: a re-test is named after the cards it tests, a
 * recording after the board and its time.
 * <ul>
 *   <li>one card: {@code Re-test #76 · Air Arabia baggage differs}</li>
 *   <li>several: {@code Re-test #76 #81 #83 · 3 cards}; past three, {@code Re-test #76 #81 #83 +2 · 5 cards}</li>
 *   <li>a re-test with no card: {@code <board> · re-test 2026-10-18 13:16}; a recording: {@code <board> · rec 2026-10-18 13:16}</li>
 * </ul>
 */
public final class CycleNaming {

    public static final int MAX = 160;
    private static final DateTimeFormatter WHEN = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm").withZone(ZoneOffset.UTC);

    private CycleNaming() {
    }

    /** A card the re-test tests: its number and title. */
    public record Tested(int number, String title) {
    }

    public static String retest(List<Tested> cards, String boardName, Instant at) {
        if (cards == null || cards.isEmpty()) {
            return cut(boardName + " · re-test " + WHEN.format(at));
        }
        if (cards.size() == 1) {
            Tested c = cards.get(0);
            String title = c.title() == null ? "" : c.title().strip().replaceAll("\\s+", " ");
            return cut("Re-test #" + c.number() + (title.isEmpty() ? "" : " · " + title));
        }
        StringBuilder s = new StringBuilder("Re-test");
        for (int i = 0; i < Math.min(3, cards.size()); i++) {
            s.append(" #").append(cards.get(i).number());
        }
        if (cards.size() > 3) {
            s.append(" +").append(cards.size() - 3);
        }
        return cut(s.append(" · ").append(cards.size()).append(" cards").toString());
    }

    public static String recording(String boardName, Instant at) {
        return cut(boardName + " · rec " + WHEN.format(at));
    }

    private static String cut(String s) {
        return s.length() <= MAX ? s : s.substring(0, MAX - 1) + "…";
    }
}
