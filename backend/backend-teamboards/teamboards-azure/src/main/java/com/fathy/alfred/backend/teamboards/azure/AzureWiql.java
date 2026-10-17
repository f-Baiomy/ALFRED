package com.fathy.alfred.backend.teamboards.azure;

import com.fathy.alfred.backend.teamboards.spi.model.ItemQuery;
import com.fathy.alfred.backend.teamboards.spi.model.ItemQuery.Mine;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * A live search as WIQL (specs/028 R2): every filter is a clause, every value quoted, nothing of the user's text ever
 * becomes WIQL syntax. Pure, so it is tested on its own.
 */
final class AzureWiql {

    private AzureWiql() {
    }

    static String quote(String s) {
        return "'" + s.replace("'", "''") + "'";
    }

    static String in(Collection<String> values) {
        List<String> q = new ArrayList<>();
        for (String v : values) {
            q.add(quote(v));
        }
        return "(" + String.join(", ", q) + ")";
    }

    /** Who "me" is in WIQL: the token's owner (@Me), or the person named by "This is me". */
    static String me(ItemQuery q) {
        return q.meUniqueName() == null ? "@Me" : quote(q.meUniqueName());
    }

    static String person(ItemQuery q, String who) {
        return "me".equalsIgnoreCase(who) ? me(q) : quote(who);
    }

    /**
     * The WHERE of a search. {@code projects}: the scope (empty: every project the token sees); {@code closedStates}: the
     * states whose category is Completed or Removed (Open only); {@code teamAreas}: each team's area paths, with
     * {@code true} for "and its children"; {@code currentIteration}: the @CurrentIteration macro to use.
     */
    static String where(ItemQuery q, List<String> projects, Set<String> closedStates, Map<String, Boolean> teamAreas, String currentIteration) {
        List<String> and = new ArrayList<>();
        if (!projects.isEmpty()) {
            and.add("[System.TeamProject] IN " + in(projects));
        }
        if (q.text() != null) {
            List<String> or = new ArrayList<>();
            or.add("[System.Title] CONTAINS " + quote(q.text()));
            if (q.text().matches("#?\\d{1,9}")) {
                or.add("[System.Id] = " + q.text().replace("#", ""));
            }
            and.add("(" + String.join(" OR ", or) + ")");
        }
        if (!q.types().isEmpty()) {
            and.add("[System.WorkItemType] IN " + in(q.types()));
        }
        if (!q.states().isEmpty()) {
            and.add("[System.State] IN " + in(q.states()));
        } else if (q.openOnly() && !closedStates.isEmpty()) {
            and.add("[System.State] NOT IN " + in(closedStates));
        }
        if (!q.areas().isEmpty()) {
            List<String> or = new ArrayList<>();
            for (String a : q.areas()) {
                or.add("[System.AreaPath] UNDER " + quote(a));
            }
            and.add("(" + String.join(" OR ", or) + ")");
        }
        if (!teamAreas.isEmpty()) {
            List<String> or = new ArrayList<>();
            teamAreas.forEach((path, children) -> or.add("[System.AreaPath] " + (children ? "UNDER " : "= ") + quote(path)));
            and.add("(" + String.join(" OR ", or) + ")");
        }
        if (!q.iterations().isEmpty()) {
            List<String> or = new ArrayList<>();
            for (String i : q.iterations()) {
                or.add("@current".equalsIgnoreCase(i) ? "[System.IterationPath] = " + currentIteration : "[System.IterationPath] UNDER " + quote(i));
            }
            and.add("(" + String.join(" OR ", or) + ")");
        }
        if (q.assigned() != null) {
            and.add("none".equalsIgnoreCase(q.assigned()) ? "[System.AssignedTo] = ''" : "[System.AssignedTo] = " + person(q, q.assigned()));
        }
        if (q.createdBy() != null) {
            and.add("[System.CreatedBy] = " + person(q, q.createdBy()));
        }
        if (q.changedWithinDays() != null) {
            and.add("[System.ChangedDate] >= @Today - " + q.changedWithinDays());
        }
        for (String t : q.tags()) {
            and.add("[System.Tags] CONTAINS " + quote(t));
        }
        if (q.parent() != null && q.parent().matches("\\d{1,9}")) {
            and.add("[System.Parent] = " + q.parent());
        }
        if (!q.mine().isEmpty()) {
            List<String> or = new ArrayList<>();
            String me = me(q);
            for (Mine m : q.mine()) {
                switch (m) {
                    case ASSIGNED -> or.add("[System.AssignedTo] = " + me);
                    case CREATED -> or.add("[System.CreatedBy] = " + me);
                    case CHANGED -> or.add("[System.ChangedBy] EVER " + me);
                    case MENTIONED -> {
                        if (q.meUniqueName() == null) {
                            or.add("[System.Id] IN (@RecentMentions)");
                        }
                    }
                    case FOLLOWED -> {
                        if (q.meUniqueName() == null) {
                            or.add("[System.Id] IN (@Follows)");
                        }
                    }
                }
            }
            // mentioned / followed only exist for the token's owner: for a picked "me" they match nothing, never everything
            and.add(or.isEmpty() ? "[System.Id] < 0" : "(" + String.join(" OR ", or) + ")");
        }
        return and.isEmpty() ? "[System.Id] > 0" : String.join(" AND ", and);
    }

    static String order(ItemQuery.Sort sort) {
        return switch (sort) {
            case ID -> " ORDER BY [System.Id] DESC";
            case PRIORITY -> " ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.ChangedDate] DESC";
            case CHANGED -> " ORDER BY [System.ChangedDate] DESC";
        };
    }

    /** Whether the full-text Search API can answer the query (it filters project, type, state, assignee and area only). */
    static boolean searchable(ItemQuery q) {
        return q.text() != null && q.iterations().isEmpty() && q.createdBy() == null && q.changedWithinDays() == null && q.tags().isEmpty()
                && q.parent() == null && q.mine().isEmpty() && q.teams().isEmpty() && (q.assigned() == null || !"me".equalsIgnoreCase(q.assigned()));
    }
}
