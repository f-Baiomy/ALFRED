package com.fathy.alfred.backend.board.domain;

import com.fathy.alfred.backend.board.domain.model.Team;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Which teams a card's own words point at: a team matches when one of its hints appears in the card's title or
 * description (mentions included, in their {@code @[type:ref|label]} form). Case is ignored, and "/" and "." are the
 * same character, so a package hint {@code com.x.supplier} also matches the path {@code com/x/supplier/...} of a code
 * mention. Used only to pre-fill a card created without teams.
 */
public final class TeamHints {

    private TeamHints() {
    }

    public static List<Match> match(List<Team> teams, String title, String description) {
        String text = normalize((title == null ? "" : title) + "\n" + (description == null ? "" : description));
        List<Match> out = new ArrayList<>();
        for (Team team : teams) {
            for (String hint : team.hints()) {
                String h = normalize(hint.replace("*", ""));
                if (!h.isBlank() && text.contains(h)) {
                    out.add(new Match(team.id(), hint));
                    break;
                }
            }
        }
        return out;
    }

    private static String normalize(String s) {
        return s.toLowerCase(Locale.ROOT).replace('/', '.');
    }

    /** A team and the hint that matched it - the hint is shown in the card's history as the reason. */
    public record Match(String teamId, String hint) {
    }
}
