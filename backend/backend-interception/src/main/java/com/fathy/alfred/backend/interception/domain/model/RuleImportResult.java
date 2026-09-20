package com.fathy.alfred.backend.interception.domain.model;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * What happened to each rule in an imported file.
 *
 * <p>Per rule rather than one pass/fail, because a rules file is not atomic in any useful sense.
 * Throwing away nine working rules because a tenth is malformed is the worse failure - but a
 * quiet partial import is worse still, so every rejection carries the validator's own words and
 * the index it had in the file, and the dialog shows all of them.
 */
public record RuleImportResult(int imported, int rejected, List<Outcome> results) {

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Outcome(
            /** Position in the file, so the UI can point at the rule that failed. */
            int index,
            String name,
            /** "imported" or "rejected". */
            String status,
            /** The id it was given, for an imported rule. */
            String id,
            /** Every problem at once, never just the first. */
            List<String> problems) {

        public static Outcome imported(int index, String name, String id) {
            return new Outcome(index, name, "imported", id, null);
        }

        public static Outcome rejected(int index, String name, List<String> problems) {
            return new Outcome(index, name, "rejected", null, List.copyOf(problems));
        }
    }
}
