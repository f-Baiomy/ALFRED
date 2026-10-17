package com.fathy.alfred.backend.teamboards.spi.model;

import java.util.List;
import java.util.Set;

/**
 * A live search (specs/028 FR-010/011, specs/029). Every list is optional and its values are ORed; filters are ANDed.
 * {@code openOnly} leaves out the states whose category is Completed or Removed. {@code assigned}, {@code createdBy}: people's
 * unique names, "me", and (assigned only) "none" for unassigned. {@code areaExact}: an area matches only itself, not its
 * sub-areas. {@code iterations} may hold "@current" (each picked team's current sprint). {@code teams}: "Project\Team"
 * names, matched by the team's own area paths. {@code tagsAll}: every tag must be there (else any one). {@code parents}:
 * direct children of these ids. {@code mine}: the "Mine" sources to OR together. {@code meUniqueName}: who "me" is when
 * it is not the token's owner (then MENTIONED and FOLLOWED, which only the owner has, are left out).
 */
public record ItemQuery(String text, List<String> types, List<String> states, boolean openOnly, List<String> areas, boolean areaExact, List<String> teams,
                        List<String> iterations, List<String> assigned, List<String> createdBy, Integer changedWithinDays, List<String> tags,
                        boolean tagsAll, List<String> parents, Set<Mine> mine, String meUniqueName, Sort sort, int page, int pageSize) {

    public enum Mine { ASSIGNED, CREATED, CHANGED, MENTIONED, FOLLOWED }

    public enum Sort { CHANGED, ID, PRIORITY }

    public static final int MAX_PAGE_SIZE = 50;

    public ItemQuery {
        types = types == null ? List.of() : List.copyOf(types);
        states = states == null ? List.of() : List.copyOf(states);
        areas = areas == null ? List.of() : List.copyOf(areas);
        teams = teams == null ? List.of() : List.copyOf(teams);
        iterations = iterations == null ? List.of() : List.copyOf(iterations);
        tags = tags == null ? List.of() : List.copyOf(tags);
        assigned = assigned == null ? List.of() : List.copyOf(assigned);
        createdBy = createdBy == null ? List.of() : List.copyOf(createdBy);
        parents = parents == null ? List.of() : List.copyOf(parents);
        mine = mine == null ? Set.of() : Set.copyOf(mine);
        sort = sort == null ? Sort.CHANGED : sort;
        page = Math.max(0, page);
        pageSize = Math.max(1, Math.min(pageSize <= 0 ? MAX_PAGE_SIZE : pageSize, MAX_PAGE_SIZE));
    }
}
