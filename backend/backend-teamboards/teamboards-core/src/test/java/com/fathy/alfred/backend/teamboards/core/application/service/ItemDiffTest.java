package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.FieldDiff;
import com.fathy.alfred.backend.teamboards.spi.model.Comment;
import com.fathy.alfred.backend.teamboards.spi.model.Item;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** specs/028 FR-036: field by field, bookkeeping left out, links and new comments named, values whole. */
class ItemDiffTest {

    static Item with(Map<String, String> fields, int rev) {
        Item i = FakeTracker.item("7", "Bug", "t", "New", null, rev);
        return new Item(i.extId(), i.type(), false, i.title(), i.state(), i.assignee(), i.squad(), i.sprint(), i.area(), i.url(), rev, i.changedAt(),
                i.changedBy(), fields, i.links(), null, i.identities(), i.project());
    }

    @Test
    void bookkeepingIsNotADifference() {
        Map<String, String> a = new LinkedHashMap<>(Map.of("System.Title", "A", "System.Rev", "1", "System.ChangedDate", "x"));
        Map<String, String> b = new LinkedHashMap<>(Map.of("System.Title", "A", "System.Rev", "2", "System.ChangedDate", "y"));
        assertThat(ItemDiff.diff(with(a, 1), List.of(), with(b, 2), List.of())).isEmpty();
    }

    @Test
    void fieldsCommentsAndValuesInFull() {
        String longText = "x".repeat(10_000);
        Map<String, String> a = new LinkedHashMap<>(Map.of("System.Title", "A", "System.Description", "short"));
        Map<String, String> b = new LinkedHashMap<>(Map.of("System.Title", "B", "System.Description", longText, "Custom.Severity", "1"));
        List<FieldDiff> d = ItemDiff.diff(with(a, 1), List.of(), with(b, 2), List.of(new Comment("9", "Omar", Instant.now(), "Seen again")));
        assertThat(d).extracting(FieldDiff::field).containsExactly("Custom.Severity", "System.Description", "System.Title", "comments");
        assertThat(d.get(1).to()).hasSize(10_000);
        assertThat(d.get(3).to()).contains("1 new").contains("Omar").contains("Seen again");
    }
}
