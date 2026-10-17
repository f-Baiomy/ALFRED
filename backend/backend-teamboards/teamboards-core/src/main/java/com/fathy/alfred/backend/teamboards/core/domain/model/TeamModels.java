package com.fathy.alfred.backend.teamboards.core.domain.model;

import com.fathy.alfred.backend.teamboards.spi.model.Capability;
import com.fathy.alfred.backend.teamboards.spi.model.Link;
import com.fathy.alfred.backend.teamboards.spi.model.Scope;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The Team tab's records (specs/027 data-model.md Part 2): what the cache holds and what the REST API answers. Neutral
 * terms only - each connector maps its provider's words onto them.
 */
public final class TeamModels {

    private TeamModels() {
    }

    /** An installed connector (or a known one that is not installed) and what it can do. */
    public record ConnectorInfo(String kind, String displayName, boolean installed, Set<Capability> capabilities,
                                Map<String, String> words) {
    }

    /** One configured provider account. {@code newChanges}: changes after the shared "seen" mark. */
    public record ConnectionRow(String id, String kind, String name, String baseUrl, Scope scope, Instant fetchedAt, String fetchedBy,
                                Instant seenAt, Instant createdAt, Set<Capability> capabilities, int newChanges) {
    }

    /** A list row: never the fields or the raw item. */
    public record ItemSummary(String conn, String extId, String type, boolean customType, String title, String state, String assignee,
                              String squad, String sprint, String area, String url, int rev, Instant changedAt) {
    }

    /** One field with where it goes in a board's seed (PURPOSE / STEPS / ACCEPTANCE / CONTEXT), null when unmapped. */
    public record ItemField(String key, String value, String mappedTo) {
    }

    /** A whole item: its fields, its links, the Alfred board it opened (or null) and a waiting start's state. */
    public record ItemDetail(ItemSummary item, List<ItemField> fields, List<Link> links, String board, String startState) {
    }

    public record ItemQuery(String conn, String q, String type, String squad, String state, String assignee, String sprint,
                            int offset, int limit) {
    }

    public record ItemsPage(List<ItemSummary> items, int total) {
    }

    public record RevisionRow(int rev, String by, Instant at, List<com.fathy.alfred.backend.teamboards.spi.model.FieldChange> changes) {
    }

    /** One line of the changes feed; {@code fresh}: after the shared seen mark. */
    public record ChangeRow(long id, String conn, String extId, int rev, String by, String squad, Instant at, String summary, String title,
                            boolean fresh) {
    }

    public record SquadRow(String conn, String extId, String name, String project, String alfredProject, String alfredTeam,
                           List<String> members) {
    }

    public record PersonRow(String extId, String name, String email) {
    }

    public record BoardRow(String extId, String name, String project, String team, List<String> columns) {
    }

    public record SprintRow(String extId, String name, String team, Instant starts, Instant ends) {
    }

    public enum MappingKind { SPRINT, SQUAD, AREA, PROJECT }

    /** Items of {@code kind} = {@code extValue} open their boards in {@code alfredProject} (on {@code alfredBoard} when set). */
    public record MappingRow(long id, String conn, MappingKind kind, String extValue, String alfredProject, String alfredBoard) {
    }

    public enum SeedTarget { PURPOSE, STEPS, ACCEPTANCE, CONTEXT }

    public record FieldMapRow(String conn, String itemType, String field, SeedTarget target) {
    }

    /** An Alfred board opened from a work item: the snapshot of the item when the board was set up, and the rev seen. */
    public record BoardLinkRow(String alfredBoard, String conn, String extId, String snapshotJson, int seenRev) {
    }

    public enum RefreshOutcome { OK, STARTED, TOKEN_MISSING, TOKEN_REJECTED, PROVIDER_BUSY, UNREACHABLE, NOT_FOUND, BAD_RESPONSE }

    public record RefreshResult(RefreshOutcome outcome, int changed, Instant fetchedAt, Integer retryAfter, String message) {
        public static RefreshResult of(RefreshOutcome o, String message) {
            return new RefreshResult(o, 0, null, null, message);
        }
    }
}
