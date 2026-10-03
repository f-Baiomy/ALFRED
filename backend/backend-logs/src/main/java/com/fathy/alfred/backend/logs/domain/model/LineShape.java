package com.fathy.alfred.backend.logs.domain.model;

import java.util.List;
import java.util.Map;

/**
 * One structure found among a source's lines: lines whose stored fields are mostly the same set
 * (see {@code ShapeMatcher}). Shown as "S‹id›" in the explorer, filterable, renameable, and may have
 * its own summary template.
 *
 * @param fields      field indexes of the first line of this structure (what later lines are compared with)
 * @param fieldCounts field index → lines of this structure that have the field ("seen in X %")
 * @param name        user-given name, or null (the service then names it after its most telling field)
 * @param template    summary template for these lines, or null/empty to use the source's template
 */
public record LineShape(int id, String name, String template, List<Integer> fields, long lineCount, Map<Integer, Long> fieldCounts) {
}
