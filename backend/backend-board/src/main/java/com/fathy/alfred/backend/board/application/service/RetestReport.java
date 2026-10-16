package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.domain.model.RetestCheck;
import com.fathy.alfred.backend.board.domain.model.RetestCheck.Verdict;

import java.time.Instant;
import java.util.List;
import java.util.stream.Collectors;

/** A re-test as Markdown for the team (specs/016 FR-12): passed, failed, flaky, partly checked and not covered. */
final class RetestReport {

    private RetestReport() {
    }

    static String markdown(String project, Instant at, String source, List<RetestCheck> checks, Instant build) {
        StringBuilder out = new StringBuilder();
        out.append("## Re-test ").append(project.isEmpty() ? "No project" : project).append(" · ").append(at).append('\n');
        out.append("From ").append(source.equals("live") ? "live calls since each fix" : "re-test cycle " + source.substring(6));
        if (build != null) {
            out.append(" · app started ").append(build);
        }
        out.append("\n\n");
        section(out, "Passed", checks, Verdict.PASSES);
        section(out, "Failed", checks, Verdict.FAILS);
        section(out, "Flaky", checks, Verdict.FLAKY);
        section(out, "Partly checked", checks, Verdict.PARTIAL);
        section(out, "Not covered", checks, Verdict.NO_CALLS);
        section(out, "Cannot check", checks, Verdict.NOT_CHECKABLE);
        return out.toString().trim() + "\n";
    }

    /** " · implemented ✓" / " · not implemented: NOT_IN_BUILD" / " · code not checked" (specs/026). */
    static String implemented(RetestCheck c) {
        if (c.code() == null) {
            return " · code not checked";
        }
        if (c.code().implemented()) {
            return c.verdict() == Verdict.PASSES ? " · implemented ✓ and worked ✓ - ready for Verified" : " · implemented ✓";
        }
        return " · not implemented: " + c.code().verdict() + (c.code().note() == null ? "" : " (" + c.code().note() + ")");
    }

    private static void section(StringBuilder out, String title, List<RetestCheck> checks, Verdict verdict) {
        List<RetestCheck> these = checks.stream().filter(c -> c.verdict() == verdict).toList();
        if (these.isEmpty()) {
            return;
        }
        out.append("**").append(title).append(" (").append(these.size()).append(")**\n");
        out.append(these.stream().map(c -> "- #" + c.number() + " " + c.title() + " - " + c.summary() + implemented(c)).collect(Collectors.joining("\n")));
        out.append("\n\n");
    }
}
