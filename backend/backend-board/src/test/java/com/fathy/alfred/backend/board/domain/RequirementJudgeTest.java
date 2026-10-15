package com.fathy.alfred.backend.board.domain;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fathy.alfred.backend.board.domain.model.EvidenceCheck;
import com.fathy.alfred.backend.board.domain.model.EvidenceCheck.Kind;
import com.fathy.alfred.backend.board.domain.model.ItemEvidence;
import com.fathy.alfred.backend.board.domain.model.ItemVerdict.CallResult;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** specs/018: what one call shows about one Acceptance item, decided in code. */
class RequirementJudgeTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String OLD = "{\"branchId\":948,\"agencyIds\":[949,10646],\"pnr\":null,\"page\":1}";
    private static final String EMPTY = "{\"payload\":[],\"total\":0}";

    private static EvidenceCheck shape(String path, String shape) {
        return new EvidenceCheck(Kind.REQUEST_SHAPE, path, shape, null, null, null, null);
    }

    private static EvidenceCheck when(String path, String shape) {
        return new EvidenceCheck(Kind.REQUEST_WHEN, path, shape, null, null, null, null);
    }

    private static final EvidenceCheck ROWS_MATCH = new EvidenceCheck(Kind.ROWS_MATCH_FILTER, "$.branch*", null, "$.payload", "branch*", null, null);
    private static final EvidenceCheck ROWS = new EvidenceCheck(Kind.ROWS_PRESENT, null, null, "$.payload", null, null, null);

    private static JsonNode tree(String s) throws Exception {
        return s == null ? null : JSON.readTree(s);
    }

    private static RequirementJudge.Judgement judge(List<EvidenceCheck> checks, String request, String response) throws Exception {
        return RequirementJudge.judge(checks, tree(request), tree(response), 200);
    }

    @Test
    void oneBranchIdWhereAListMustFitContradictsTheItemWhateverTheUserChose() throws Exception {
        RequirementJudge.Judgement j = judge(List.of(shape("$.branch*", "list"), when("$.branch*", "list>=2"), ROWS_MATCH, ROWS), OLD, EMPTY);
        assertThat(j.result()).isEqualTo(CallResult.CONTRADICTS);
        assertThat(j.reason()).isEqualTo("request $.branch* is a list - sent branchId: 948");
    }

    @Test
    void aCallAboutAnotherChoiceIsNotCounted() throws Exception {
        // new code, one branch chosen: says nothing about "All Branches"
        String one = "{\"branchIds\":[948],\"agencyIds\":[949]}";
        assertThat(judge(List.of(shape("$.branch*", "list"), when("$.branch*", "none"), ROWS), one, "{\"payload\":[{\"branchId\":948}]}")).isNull();
    }

    @Test
    void allBranchesMayLeaveTheFieldOutOrSendAnAllMarker() throws Exception {
        List<EvidenceCheck> checks = List.of(shape("$.branch*", "list"), when("$.branch*", "none"), ROWS);
        String rows = "{\"payload\":[{\"branchId\":1},{\"branchId\":2}]}";
        assertThat(judge(checks, "{\"agencyIds\":[949]}", rows).result()).isEqualTo(CallResult.MEETS);
        assertThat(judge(checks, "{\"branchIds\":[]}", rows).result()).isEqualTo(CallResult.MEETS);
        assertThat(judge(checks, "{\"branchIds\":[\"ALL\"]}", rows).result()).isEqualTo(CallResult.MEETS);
        assertThat(judge(checks, "{\"branchIds\":-1}", rows).result()).isEqualTo(CallResult.MEETS);
    }

    @Test
    void severalBranchesThatLeakAnotherBranchIsWrong() throws Exception {
        List<EvidenceCheck> checks = List.of(shape("$.branch*", "list"), when("$.branch*", "list>=2"), ROWS_MATCH, ROWS);
        RequirementJudge.Judgement j = judge(checks, "{\"branchIds\":[1,2]}", "{\"payload\":[{\"branchId\":1},{\"branchId\":\"7\"}]}");
        assertThat(j.result()).isEqualTo(CallResult.WRONG);
        assertThat(j.reason()).contains("row 1 has branch* \"7\"");
        assertThat(judge(checks, "{\"branchIds\":[1,2]}", "{\"payload\":[{\"branchId\":1},{\"branchId\":\"2.0\"}]}").result())
                .isEqualTo(CallResult.MEETS);
    }

    @Test
    void theRightRequestWithNoRowsProvesNothingYet() throws Exception {
        List<EvidenceCheck> checks = List.of(when("$.branch*", "one"), ROWS_MATCH, ROWS);
        RequirementJudge.Judgement j = judge(checks, OLD, EMPTY);
        assertThat(j.result()).isEqualTo(CallResult.NO_DATA);
        assertThat(j.reason()).isEqualTo("response $.payload has rows - 0 rows");
    }

    @Test
    void aWildcardNamingTwoFieldsOrAMissingBodyIsUnknownNeverMissing() throws Exception {
        String both = "{\"branchId\":948,\"branchIds\":[948]}";
        RequirementJudge.Judgement j = judge(List.of(shape("$.branch*", "list")), both, EMPTY);
        assertThat(j.result()).isEqualTo(CallResult.UNKNOWN);
        assertThat(j.reason()).contains("branch* matches both branchId and branchIds");
        assertThat(judge(List.of(shape("$.branch*", "list")), null, EMPTY).result()).isEqualTo(CallResult.UNKNOWN);
        assertThat(judge(List.of(when("$.branchId", "one"), ROWS), OLD, "{\"total\":0}").result()).isEqualTo(CallResult.UNKNOWN);
    }

    @Test
    void anExplicitFieldThatIsAbsentCannotCarryAValue() throws Exception {
        assertThat(judge(List.of(shape("$.branchIds", "present")), OLD, EMPTY).result()).isEqualTo(CallResult.CONTRADICTS);
        assertThat(judge(List.of(shape("$.filter.branch*", "list")), "{\"filter\":{\"branchIds\":[1]}}", EMPTY).result())
                .isEqualTo(CallResult.MEETS);
    }

    @Test
    void aStatusOutsideTheRangeIsWrong() throws Exception {
        EvidenceCheck ok = new EvidenceCheck(Kind.STATUS, null, null, null, null, null, "2xx");
        assertThat(RequirementJudge.judge(List.of(ok), tree(OLD), tree(EMPTY), 500).result()).isEqualTo(CallResult.WRONG);
    }

    @Test
    void evidenceIsValidatedBeforeItIsSaved() {
        assertThat(shape("$.branch*", "list>=2").problem()).contains("REQUEST_SHAPE needs shape");
        assertThat(when("branch", "none").problem()).contains("REQUEST_WHEN needs a request path");
        assertThat(new EvidenceCheck(Kind.ROWS_PRESENT, null, null, "$.pay*", null, null, null).problem()).contains("ROWS_PRESENT needs rows");
        assertThat(new ItemEvidence("c", "spec.md", "k", "p", "search the page", List.of(), "", null, null).problem())
                .contains("endpoint must be METHOD /path");
        assertThat(new ItemEvidence("c", "spec.md", "k", "p", "UI", List.of(), "", null, null).problem()).isNull();
        assertThat(new ItemEvidence("c", "spec.md", "k", "p", "POST /x", List.of(), "", null, null).problem()).contains("at least one check");
    }

    @Test
    void endpointsMatchAcrossPlaceholderStyles() {
        assertThat(EndpointPattern.matches("POST /odeysysadmin/Booking2/refunded-requests/search",
                "POST /odeysysadmin/{x}/refunded-requests/search")).isTrue();
        assertThat(EndpointPattern.matches("POST /odeysysadmin/:id/refunded-requests/search",
                "POST /odeysysadmin/Booking2/refunded-requests/search")).isTrue();
        assertThat(EndpointPattern.matches("POST /a/search", "GET /a/search")).isFalse();
        assertThat(EndpointPattern.matches("POST /api/v2/search", "POST /api/v3/search")).isFalse();
        assertThat(EndpointPattern.matches("POST /a/search", "POST /a/search/export")).isFalse();
    }

    // ------------------------------------------------------------------------------------------------- specs/020

    @Test
    void anAppsOwnAllMarkerIsMatchedWithHas() throws Exception {
        String all = "{\"branchIds\":[948,10642,965],\"agencyIds\":[-11],\"page\":1}";
        // "-11" is not an all marker Alfred knows: REQUEST_WHEN none leaves the call out ...
        assertThat(judge(List.of(when("$.agencyIds", "none"), ROWS), all, EMPTY)).isNull();
        // ... has:-11 takes it, and its empty answer is NO_DATA - exercised, not proven
        EvidenceCheck has = when("$.agencyIds", "has:-11");
        assertThat(has.problem()).isNull();
        assertThat(has.text()).isEqualTo("when request $.agencyIds is or holds -11");
        assertThat(judge(List.of(has, ROWS), all, EMPTY).result()).isEqualTo(com.fathy.alfred.backend.board.domain.model.ItemVerdict.CallResult.NO_DATA);
        assertThat(judge(List.of(has, ROWS), "{\"agencyIds\":[949]}", EMPTY)).isNull();
        assertThat(when("$.agencyIds", "has:").problem()).contains("has:<value>");
    }

    @Test
    void aStepsRequestAndAnEmptyAnswerAreReadTheSameWay() throws Exception {
        assertThat(RequirementJudge.requestHolds(tree("{\"branchIds\":[-11]}"), "$.branchIds", "has:-11")).isTrue();
        assertThat(RequirementJudge.requestHolds(tree(OLD), "$.branchIds", "has:-11")).isFalse();
        assertThat(RequirementJudge.requestHolds(tree(OLD), "$.branch*", "one")).isTrue();
        assertThat(RequirementJudge.requestHolds(null, "$.branchIds", "list")).isNull();
        assertThat(RequirementJudge.emptyAnswer(tree(EMPTY))).isTrue();
        assertThat(RequirementJudge.emptyAnswer(tree("[]"))).isTrue();
        assertThat(RequirementJudge.emptyAnswer(tree("{\"data\":{\"items\":[]}}"))).isTrue();
        assertThat(RequirementJudge.emptyAnswer(tree("{\"payload\":[{\"id\":1}],\"total\":1}"))).isFalse();
        assertThat(RequirementJudge.emptyAnswer(tree("{\"payload\":[],\"total\":12}"))).isFalse();
        assertThat(RequirementJudge.emptyAnswer(tree("{\"ok\":true}"))).isFalse();
    }
}
