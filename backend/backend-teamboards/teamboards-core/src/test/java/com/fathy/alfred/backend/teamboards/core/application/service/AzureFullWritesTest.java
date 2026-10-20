package com.fathy.alfred.backend.teamboards.core.application.service;

import com.fathy.alfred.backend.teamboards.core.application.port.in.AzureWritesUseCase.NewBundle;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamException;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.StateRow;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.StepKind;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WriteBundle;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WriteState;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.WriteStep;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who;
import com.fathy.alfred.backend.teamboards.spi.model.NewItem;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static com.fathy.alfred.backend.teamboards.core.application.service.FakeTracker.item;
import static com.fathy.alfred.backend.teamboards.core.application.service.TeamFixture.CONN;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** specs/038: everything a person can do with a work item, as bundles only the user approves. */
class AzureFullWritesTest {

    @TempDir
    Path dir;
    TeamFixture f;

    @BeforeEach
    void setUp() {
        f = new TeamFixture(dir);
        f.tracker.put(item("62565", "User Story", "Portal: Knowledge Base Display", "Active", null, 3))
                .put(item("62555", "User Story", "Admin: Knowledge Base Management", "Active", null, 4))
                .put(item("102", "Task", "Old task", "Active", "62565", 2));
        f.tracker.requiredOnTask = "Microsoft.VSTS.Common.Activity";
    }

    @AfterEach
    void tearDown() {
        f.close();
    }

    private static WriteStep create(String parent, String title, Map<String, String> more) {
        Map<String, String> p = new LinkedHashMap<>(Map.of("type", "Task", "title", title, "parent", parent, "assignee", "f.biomy@tildetech.ae"));
        p.putAll(more);
        return new WriteStep(StepKind.CREATE, p, true, false, null);
    }

    private static final String TASK_FIELDS = "{\"Microsoft.VSTS.Common.Activity\":\"Development\",\"Microsoft.VSTS.Scheduling.OriginalEstimate\":16,"
            + "\"Microsoft.VSTS.Scheduling.RemainingWork\":16}";

    @Test
    void twoTasksUnderDifferentParentsGoInOneBundleWithEveryFieldAndNoAlfredMark() {
        f.withToken();
        WriteBundle b = f.writes.create(Who.CLAUDE, new NewBundle("b1", null, CONN, null, "Backend tasks", List.of(
                create("62555", "BE - Admin", Map.of("fields", TASK_FIELDS, "tags", "Back-end", "description", "<p>Link validation</p>")),
                create("62565", "BE - Portal", Map.of("fields", TASK_FIELDS, "tags", "Back-end"))), null, null));

        assertThat(b.steps()).hasSize(2).allSatisfy(s -> assertThat(s.payload().get("azureCheck")).isEqualTo("ok"));
        assertThat(f.tracker.writes).isEmpty(); // checked, nothing written
        f.writes.approve(Who.USER, b.id());

        assertThat(f.tracker.created).hasSize(2);
        NewItem admin = f.tracker.created.get(0);
        assertThat(admin.parent()).isEqualTo("62555");
        assertThat(f.tracker.created.get(1).parent()).isEqualTo("62565");
        assertThat(admin.fields()).containsEntry("Microsoft.VSTS.Common.Activity", "Development")
                .containsEntry("Microsoft.VSTS.Scheduling.OriginalEstimate", "16").containsEntry("Microsoft.VSTS.Scheduling.RemainingWork", "16");
        assertThat(admin.tags()).containsExactly("Back-end");
        assertThat(admin.assignee()).isEqualTo("f.biomy@tildetech.ae");
        assertThat(f.tracker.writes).noneMatch(w -> w.startsWith("comment") || w.startsWith("tag") || w.startsWith("hyperlink"));
        assertThat(f.writes.get(b.id())).get().satisfies(x -> {
            assertThat(x.state()).isEqualTo(WriteState.DONE);
            assertThat(x.decidedBy()).isEqualTo("sara@example.com"); // the audit names who approved
        });
    }

    @Test
    void aTaskWithoutTheRequiredActivityIsRefusedWhenDraftedAndNothingIsSaved() {
        f.withToken();
        assertThatThrownBy(() -> f.writes.create(Who.CLAUDE, new NewBundle("b1", null, CONN, null, "Backend task", List.of(
                create("62565", "BE - Portal", Map.of())), null, null)))
                .isInstanceOf(TeamException.class).hasMessageContaining("TF401320").hasMessageContaining("Activity").hasMessageContaining("nothing was saved");
        assertThat(f.writes.list("b1", null, null, 10)).isEmpty();
        assertThat(f.fields.fields(CONN, "Odeysys", "Task", false)).singleElement()
                .satisfies(fi -> assertThat(fi.allowed()).contains("Development"));
    }

    @Test
    void oneEditChangesTheEstimateTheParentAndATagShowingBeforeAndAfter() {
        f.withToken();
        WriteBundle b = f.writes.create(Who.CLAUDE, new NewBundle("b1", null, CONN, "102", "Re-plan", List.of(new WriteStep(StepKind.FIELD,
                Map.of("fields", "{\"Microsoft.VSTS.Scheduling.RemainingWork\":8}", "parent", "62555", "addTags", "Back-end"), true, false, null)),
                null, null));
        Map<String, String> p = b.steps().get(0).payload();
        assertThat(p.get("fromFields")).contains("RemainingWork");
        assertThat(p.get("fromParent")).isEqualTo("62565");
        f.writes.approve(Who.USER, b.id());
        assertThat(f.tracker.writes).containsExactly("update 102 {Microsoft.VSTS.Scheduling.RemainingWork=8} parent=62555 +tags=[Back-end]");
    }

    @Test
    void aStepForAnotherItemNamesItAndABulkEditIsOneBundle() {
        f.withToken();
        WriteBundle b = f.writes.create(Who.CLAUDE, new NewBundle("b1", null, CONN, null, "Move to Sprint 2", List.of(
                new WriteStep(StepKind.FIELD, Map.of("item", "62565", "fields", "{\"System.IterationPath\":\"P\\\\Sprint 2\"}"), true, false, null),
                new WriteStep(StepKind.FIELD, Map.of("item", "62555", "fields", "{\"System.IterationPath\":\"P\\\\Sprint 2\"}"), true, false, null)),
                null, null));
        f.writes.approve(Who.USER, b.id());
        assertThat(f.tracker.writes).hasSize(2).allMatch(w -> w.contains("Sprint 2"));
        assertThat(f.tracker.writes.get(0)).startsWith("update 62565");
        assertThat(f.tracker.writes.get(1)).startsWith("update 62555");
    }

    @Test
    void aCopyAndATemplateAreFilledInWhenDraftedSoTheUserSeesEveryValue() {
        f.withToken();
        f.fields.putTemplate(Who.USER, CONN, "Backend task", "Task", Map.of("Microsoft.VSTS.Common.Activity", "Development",
                "Microsoft.VSTS.Scheduling.OriginalEstimate", "16"));
        WriteBundle b = f.writes.create(Who.CLAUDE, new NewBundle("b1", null, CONN, null, "From template", List.of(
                new WriteStep(StepKind.CREATE, Map.of("template", "backend TASK", "title", "BE - X", "parent", "62565",
                        "fields", "{\"Microsoft.VSTS.Scheduling.OriginalEstimate\":8}"), true, false, null)), null, null));
        Map<String, String> fields = StepPayloads.fields(b.steps().get(0).payload());
        assertThat(fields).containsEntry("Microsoft.VSTS.Common.Activity", "Development").containsEntry("Microsoft.VSTS.Scheduling.OriginalEstimate", "8");
        assertThat(b.steps().get(0).payload()).containsEntry("type", "Task");

        WriteBundle copy = f.writes.create(Who.CLAUDE, new NewBundle("b1", null, CONN, null, "Copy", List.of(
                new WriteStep(StepKind.CREATE, Map.of("copyOf", "102", "fields", "{\"Microsoft.VSTS.Common.Activity\":\"Testing\"}"), true, false, null)),
                null, null));
        Map<String, String> p = copy.steps().get(0).payload();
        assertThat(p).containsEntry("title", "Old task").containsEntry("type", "Task").containsEntry("parent", "62565");
        assertThat(p.get("description")).isEqualTo("About Old task");
        assertThat(StepPayloads.fields(p)).doesNotContainKey("System.State").containsEntry("Microsoft.VSTS.Common.Activity", "Testing");
    }

    @Test
    void closingInsteadOfDeletingNamesTheTypesOwnState() {
        f.withToken();
        f.cache.replaceStates(CONN, List.of(new StateRow("Odeysys", "Task", "Removed", "Removed"), new StateRow("Odeysys", "Task", "Closed", "Completed")));
        WriteBundle b = f.writes.create(Who.CLAUDE, new NewBundle("b1", null, CONN, "102", "Not needed", List.of(
                new WriteStep(StepKind.STATE, Map.of("category", "Removed"), true, false, null),
                new WriteStep(StepKind.COMMENT, Map.of("text", "Covered by 62555"), true, false, null)), null, null));
        assertThat(b.steps().get(0).payload()).containsEntry("state", "Removed").containsEntry("from", "Active");
    }

    @Test
    void onlyTheUsersBrowserDecides() {
        f.withToken();
        WriteBundle b = f.writes.create(Who.CLAUDE, new NewBundle("b1", null, CONN, "102", "Edit", List.of(new WriteStep(StepKind.FIELD,
                Map.of("field", "Microsoft.VSTS.Common.Priority", "value", "1"), true, false, null)), null, null));
        assertThatThrownBy(() -> f.writes.approve(Who.CLAUDE, b.id())).isInstanceOf(TeamException.class);
        f.refuseDecision = "A helper's key cannot approve";
        assertThatThrownBy(() -> f.writes.approve(Who.USER, b.id())).hasMessageContaining("helper");
        assertThatThrownBy(() -> f.writes.reject(Who.USER, b.id())).hasMessageContaining("helper");
        assertThatThrownBy(() -> f.fields.setClaudeMayDraft(Who.USER, true)).hasMessageContaining("helper");
        assertThat(f.tracker.writes).isEmpty();
        f.refuseDecision = null;
        f.writes.approve(Who.USER, b.id());
        assertThat(f.tracker.writes).containsExactly("field 102 Microsoft.VSTS.Common.Priority=1");
    }

    @Test
    void theKillSwitchStopsEveryDraftOfClaudesAndFiveWaitingIsTheMost() {
        f.withToken();
        f.fields.setClaudeMayDraft(Who.USER, false);
        assertThatThrownBy(() -> f.writes.create(Who.CLAUDE, new NewBundle("b1", null, CONN, "102", "Edit", List.of(new WriteStep(StepKind.FIELD,
                Map.of("field", "Microsoft.VSTS.Common.Priority", "value", "1"), true, false, null)), null, null))).hasMessageContaining("turned off");
        f.fields.setClaudeMayDraft(Who.USER, true);
        for (int i = 0; i < 5; i++) {
            f.writes.create(Who.CLAUDE, new NewBundle("b1", null, CONN, "102", "Edit " + i, List.of(new WriteStep(StepKind.FIELD,
                    Map.of("field", "Microsoft.VSTS.Common.Priority", "value", "1"), true, false, null)), null, null));
        }
        assertThatThrownBy(() -> f.writes.create(Who.CLAUDE, new NewBundle("b1", null, CONN, "102", "Edit 6", List.of(new WriteStep(StepKind.FIELD,
                Map.of("field", "Microsoft.VSTS.Common.Priority", "value", "1"), true, false, null)), null, null))).hasMessageContaining("extend");
    }

    @Test
    void claudeRedraftsAnyStepOrDropsOneAndAzureChecksItAgain() {
        f.withToken();
        WriteBundle b = f.writes.create(Who.CLAUDE, new NewBundle("b1", null, CONN, null, "Two", List.of(
                create("62555", "BE - Admin", Map.of("fields", TASK_FIELDS)), create("62565", "BE - Portal", Map.of("fields", TASK_FIELDS))), null, null));
        WriteBundle moved = f.writes.redraftStep(Who.CLAUDE, b.id(), 1, Map.of("parent", "62555", "title", "BE - Portal v2"), false);
        assertThat(moved.steps().get(1).payload()).containsEntry("parent", "62555").containsEntry("title", "BE - Portal v2").containsEntry("azureCheck", "ok");
        assertThatThrownBy(() -> f.writes.redraftStep(Who.CLAUDE, b.id(), 1, Map.of("fields", "{}"), false)).hasMessageContaining("Activity");
        WriteBundle one = f.writes.redraftStep(Who.CLAUDE, b.id(), 0, null, true);
        assertThat(one.steps()).hasSize(1);
        assertThatThrownBy(() -> f.writes.redraftStep(Who.USER, b.id(), 0, Map.of("title", "x"), false)).isInstanceOf(TeamException.class);
    }

    @Test
    void aRefusalAtApproveSendsNothing() {
        f.withToken();
        WriteBundle b = f.writes.create(Who.CLAUDE, new NewBundle("b1", null, CONN, null, "Task", List.of(
                create("62565", "BE - Portal", Map.of("fields", TASK_FIELDS))), null, null));
        f.tracker.requiredOnTask = "Microsoft.VSTS.Common.Priority"; // the process changed since the draft
        assertThatThrownBy(() -> f.writes.approve(Who.USER, b.id())).hasMessageContaining("nothing was sent");
        assertThat(f.tracker.created).isEmpty();
        assertThat(f.writes.get(b.id())).get().satisfies(x -> {
            assertThat(x.state()).isEqualTo(WriteState.WAITING);
            assertThat(x.steps().get(0).payload().get("azureCheck")).startsWith("refused: ");
        });
    }

    @Test
    void theFieldsOfATypeAreKeptForADay() {
        f.withToken();
        f.fields.fields(CONN, "Odeysys", "Task", false);
        f.fields.fields(CONN, "Odeysys", "Task", false);
        assertThat(f.tracker.fieldReads).isEqualTo(1);
        f.fields.fields(CONN, "Odeysys", "Task", true);
        assertThat(f.tracker.fieldReads).isEqualTo(2);
    }
}
