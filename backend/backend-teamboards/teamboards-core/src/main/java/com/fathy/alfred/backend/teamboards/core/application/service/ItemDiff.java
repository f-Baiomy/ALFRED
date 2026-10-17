package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.FieldDiff;
import com.fathy.alfred.backend.teamboards.spi.model.Comment;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import com.fathy.alfred.backend.teamboards.spi.model.Link;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;

/**
 * Field by field: what Azure has now against the saved copy (specs/028 FR-036). Bookkeeping fields (rev, dates,
 * watermark) are left out; relations show as "links +x / -y", new comments as "comments" with the count and the newest.
 * Values are whole - nothing is cut.
 */
public final class ItemDiff {

    /** Fields every save changes: no reader needs them in a diff. */
    static final Set<String> NOISE = Set.of("system.rev", "system.changeddate", "system.authorizeddate", "system.reviseddate", "system.watermark",
            "system.authorizedas", "system.personid", "system.changedby", "system.commentcount", "system.id", "system.boardcolumndone",
            "microsoft.vsts.common.statechangedate");

    private ItemDiff() {
    }

    public static List<FieldDiff> diff(Item before, List<Comment> beforeComments, Item now, List<Comment> nowComments) {
        List<FieldDiff> out = new ArrayList<>();
        if (before == null || now == null) {
            return out;
        }
        Map<String, String> a = before.fields();
        Map<String, String> b = now.fields();
        Set<String> keys = new TreeSet<>(a.keySet());
        keys.addAll(b.keySet());
        for (String k : keys) {
            if (NOISE.contains(k.toLowerCase(java.util.Locale.ROOT))) {
                continue;
            }
            String x = a.get(k);
            String y = b.get(k);
            if (!Objects.equals(norm(x), norm(y))) {
                out.add(new FieldDiff(k, x, y));
            }
        }
        if (a.isEmpty() && b.isEmpty()) {
            // a connector without a field map: the neutral fields at least
            add(out, "title", before.title(), now.title());
            add(out, "state", before.state(), now.state());
            add(out, "assigned", before.assignee(), now.assignee());
            add(out, "iteration", before.sprint(), now.sprint());
            add(out, "area", before.area(), now.area());
        }
        Set<String> la = links(before.links());
        Set<String> lb = links(now.links());
        Set<String> added = new LinkedHashSet<>(lb);
        added.removeAll(la);
        Set<String> removed = new LinkedHashSet<>(la);
        removed.removeAll(lb);
        if (!added.isEmpty() || !removed.isEmpty()) {
            out.add(new FieldDiff("links", removed.isEmpty() ? null : String.join(", ", removed), added.isEmpty() ? null : String.join(", ", added)));
        }
        Set<String> seen = new LinkedHashSet<>();
        for (Comment c : beforeComments == null ? List.<Comment>of() : beforeComments) {
            seen.add(c.id());
        }
        List<Comment> fresh = new ArrayList<>();
        for (Comment c : nowComments == null ? List.<Comment>of() : nowComments) {
            if (!seen.contains(c.id())) {
                fresh.add(c);
            }
        }
        if (!fresh.isEmpty() && beforeComments != null) {
            Comment newest = fresh.get(fresh.size() - 1);
            out.add(new FieldDiff("comments", null, fresh.size() + " new · newest by " + (newest.by() == null ? "?" : newest.by()) + ": "
                    + (newest.text() == null ? "" : newest.text())));
        }
        return out;
    }

    private static void add(List<FieldDiff> out, String field, String x, String y) {
        if (!Objects.equals(norm(x), norm(y))) {
            out.add(new FieldDiff(field, x, y));
        }
    }

    private static String norm(String s) {
        return s == null || s.isBlank() ? null : s.strip();
    }

    private static Set<String> links(List<Link> links) {
        Set<String> out = new TreeSet<>();
        for (Link l : links) {
            out.add(l.kind() + " " + l.toId());
        }
        return out;
    }
}
