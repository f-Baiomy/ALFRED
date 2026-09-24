package com.fathy.alfred.backend.interception.application.service;

import com.fathy.alfred.backend.interception.application.port.in.ManageStoredAnswersUseCase.CopyResult;
import com.fathy.alfred.backend.interception.application.port.in.ManageStoredAnswersUseCase.UploadResult;
import com.fathy.alfred.backend.interception.application.port.out.RecordedCallLookupPort;
import com.fathy.alfred.backend.interception.application.port.out.RecordedCallLookupPort.RecordedResponse;
import com.fathy.alfred.backend.interception.application.port.out.StoredAnswersStorePort;
import com.fathy.alfred.backend.interception.domain.model.ActionType;
import com.fathy.alfred.backend.interception.domain.model.InterceptionRule;
import com.fathy.alfred.backend.interception.domain.model.RuleAction;
import com.fathy.alfred.backend.interception.domain.model.RuleMatch;
import com.fathy.alfred.backend.interception.domain.model.StoredAnswer;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

class StoredAnswersServiceTest {

    static final Instant NOW = Instant.parse("2026-09-23T12:00:00Z");

    /** The store as a map - shared with InterceptionRulesServiceTest. */
    static class InMemoryAnswers implements StoredAnswersStorePort {
        final Map<String, StoredAnswer> meta = new LinkedHashMap<>();
        final Map<String, byte[]> bodies = new LinkedHashMap<>();
        int bodyReads;

        public void save(StoredAnswer answer, byte[] body) {
            meta.put(answer.id(), answer);
            bodies.put(answer.id(), body);
        }

        public Optional<StoredAnswer> findMeta(String id) {
            return Optional.ofNullable(meta.get(id));
        }

        public Optional<byte[]> findBody(String id) {
            bodyReads++;
            return Optional.ofNullable(bodies.get(id));
        }

        public List<StoredAnswer> listMeta() {
            return List.copyOf(meta.values());
        }

        public void delete(String id) {
            meta.remove(id);
            bodies.remove(id);
        }
    }

    private InMemoryAnswers store;
    private InterceptionRulesServiceTest.InMemoryStore rules;
    private RecordedResponse recorded;
    private StoredAnswersService service;

    @BeforeEach
    void setUp() {
        store = new InMemoryAnswers();
        rules = new InterceptionRulesServiceTest.InMemoryStore();
        RecordedCallLookupPort lookup = (direction, callId, cycleId) ->
                "known".equals(callId) ? Optional.ofNullable(recorded) : Optional.empty();
        service = new StoredAnswersService(store, lookup, rules, 100, Clock.fixed(NOW, ZoneOffset.UTC));
        recorded = response(Map.of("content-type", "application/json"), "{\"fare\":0}");
    }

    private static RecordedResponse response(Map<String, String> headers, String body) {
        return new RecordedResponse(503, headers, body.getBytes(StandardCharsets.UTF_8));
    }

    private StoredAnswer created(CopyResult result) {
        assertThat(result).isInstanceOf(CopyResult.Created.class);
        return ((CopyResult.Created) result).answer();
    }

    @Test
    void aResponseIsCopiedWithItsStatusHeadersAndBody() {
        StoredAnswer answer = created(service.copyFromCall("outbound", "known", null, null));

        assertThat(answer.kind()).isEqualTo(StoredAnswer.Kind.RECORDED);
        assertThat(answer.status()).isEqualTo(503);
        assertThat(answer.contentType()).isEqualTo("application/json");
        assertThat(answer.sizeBytes()).isEqualTo(10);
        assertThat(answer.secretsKept()).isNull();
        assertThat(StoredAnswer.isValidId(answer.id())).isTrue();
        assertThat(new String(store.bodies.get(answer.id()), StandardCharsets.UTF_8)).isEqualTo("{\"fare\":0}");
    }

    @Test
    void theFramingOfTheOriginalBytesIsNotReplayed() {
        recorded = response(Map.of("Content-Encoding", "gzip", "Content-Length", "31", "X-Trace", "t"), "decoded");

        StoredAnswer answer = created(service.copyFromCall("inbound", "known", null, null));

        assertThat(answer.headers()).containsOnlyKeys("X-Trace");
    }

    @Test
    void aCopyOverTheCapIsRefusedWithTheLimitAndTheSize() {
        recorded = response(Map.of(), "x".repeat(101));

        assertThat(service.copyFromCall("outbound", "known", null, null))
                .isEqualTo(new CopyResult.TooLarge(100, 101));
        assertThat(store.meta).isEmpty();
    }

    @Test
    void anUnknownCallIsNotFound() {
        assertThat(service.copyFromCall("outbound", "nope", null, null)).isInstanceOf(CopyResult.NotFound.class);
    }

    @Test
    void secretsNeedADecisionBeforeAnythingIsStored() {
        recorded = response(Map.of("Set-Cookie", "session=s3cret", "Authorization", "Bearer x", "X-A", "1"), "{}");

        assertThat(service.copyFromCall("outbound", "known", null, null))
                .isEqualTo(new CopyResult.SecretsDecisionRequired(List.of("authorization", "set-cookie")));
        assertThat(store.meta).isEmpty();
    }

    @Test
    void strippingSecretsRemovesTheHeadersAndTheCookiesWithThem() {
        recorded = response(Map.of("Set-Cookie", "session=s3cret", "X-A", "1"), "{}");

        StoredAnswer answer = created(service.copyFromCall("outbound", "known", null, false));

        assertThat(answer.headers()).containsOnlyKeys("X-A");
        assertThat(answer.secretsKept()).isFalse();
        assertThat(answer.secretNames()).containsExactly("set-cookie");
    }

    @Test
    void keepingSecretsKeepsThemAndSaysSo() {
        recorded = response(Map.of("Set-Cookie", "session=s3cret"), "{}");

        StoredAnswer answer = created(service.copyFromCall("outbound", "known", null, true));

        assertThat(answer.headers()).containsEntry("Set-Cookie", "session=s3cret");
        assertThat(answer.secretsKept()).isTrue();
    }

    @Test
    void theSecretNamesInTheResultCarryNoValues() throws Exception {
        recorded = response(Map.of("Set-Cookie", "session=s3cret"), "{}");

        CopyResult result = service.copyFromCall("outbound", "known", null, null);

        assertThat(new ObjectMapper().writeValueAsString(result)).doesNotContain("s3cret");
    }

    @Test
    void releaseDeletesOnlyWhatASaveStoppedReferring() {
        StoredAnswer kept = created(service.copyFromCall("outbound", "known", null, null));
        StoredAnswer dropped = created(service.copyFromCall("outbound", "known", null, null));
        StoredAnswer justPicked = created(service.copyFromCall("outbound", "known", null, null));

        service.release(Set.of(kept.id(), dropped.id()), Set.of(kept.id()));

        assertThat(store.meta).containsOnlyKeys(kept.id(), justPicked.id());
    }

    @Test
    void theSweepDeletesOldOrphansAndKeepsNewOnesAndReferencedOnes() {
        StoredAnswer oldOrphan = stored("0f8fad5b-d9cb-469f-a165-70867728950e", NOW.minus(Duration.ofHours(2)));
        StoredAnswer newOrphan = stored("7c9e6679-7425-40de-944b-e07fc1f90ae7", NOW.minus(Duration.ofMinutes(10)));
        StoredAnswer oldButUsed = stored("16fd2706-8baf-433b-82eb-8c7fada847da", NOW.minus(Duration.ofHours(5)));
        rules.rules.add(ruleUsing(oldButUsed.id()));

        service.sweepOrphans();

        assertThat(store.meta).containsOnlyKeys(newOrphan.id(), oldButUsed.id());
        assertThat(store.meta).doesNotContainKey(oldOrphan.id());
    }

    @Test
    void publishingReadsNoBodyUntilThePublisherAsks() {
        StoredAnswer answer = created(service.copyFromCall("outbound", "known", null, null));

        var published = service.publishable(Set.of(answer.id()));

        assertThat(store.bodyReads).isZero();
        assertThat(published.get(0).body().get()).isEqualTo(store.bodies.get(answer.id()));
    }

    @Test
    void anImportedAnswerGetsAFreshIdAndItsSecretsAreReDerivedFromItsHeaders() {
        StoredAnswer fromFile = new StoredAnswer("not-an-id", StoredAnswer.Kind.RECORDED, 200,
                Map.of("Set-Cookie", "a=1", "Content-Length", "9"), "text/plain", 999, false, List.of(),
                "outbound", "c", null, null, null);

        StoredAnswer imported = service.importAnswer(fromFile, "hi".getBytes(StandardCharsets.UTF_8)).orElseThrow();

        assertThat(StoredAnswer.isValidId(imported.id())).isTrue();
        assertThat(imported.sizeBytes()).isEqualTo(2);
        assertThat(imported.headers()).containsOnlyKeys("Set-Cookie");
        assertThat(imported.secretsKept()).isTrue();
        assertThat(imported.secretNames()).containsExactly("set-cookie");
    }

    @Test
    void anUploadIsStoredAsAFileAnswerWithOnlyItsContentType() {
        UploadResult result = service.upload("stub".getBytes(StandardCharsets.UTF_8), "text/plain", 404);

        assertThat(result).isInstanceOf(UploadResult.Created.class);
        StoredAnswer answer = ((UploadResult.Created) result).answer();
        assertThat(answer.kind()).isEqualTo(StoredAnswer.Kind.FILE);
        assertThat(answer.status()).isEqualTo(404);
        assertThat(answer.contentType()).isEqualTo("text/plain");
        assertThat(answer.headers()).containsOnly(Map.entry("content-type", "text/plain"));
        assertThat(answer.secretsKept()).isNull();
        assertThat(StoredAnswer.isValidId(answer.id())).isTrue();
    }

    @Test
    void anUploadWithNoContentTypeIsRefused() {
        assertThat(service.upload("stub".getBytes(StandardCharsets.UTF_8), null, null))
                .isEqualTo(new UploadResult.MissingContentType());
        assertThat(service.upload("stub".getBytes(StandardCharsets.UTF_8), "  ", null))
                .isEqualTo(new UploadResult.MissingContentType());
        assertThat(store.meta).isEmpty();
    }

    @Test
    void anUploadOverTheCapIsRefusedWithTheLimitAndTheSize() {
        assertThat(service.upload("x".repeat(101).getBytes(StandardCharsets.UTF_8), "text/plain", null))
                .isEqualTo(new UploadResult.TooLarge(100, 101));
        assertThat(store.meta).isEmpty();
    }

    private StoredAnswer stored(String id, Instant createdAt) {
        StoredAnswer answer = new StoredAnswer(id, StoredAnswer.Kind.RECORDED, 200, Map.of(), null, 0, null,
                List.of(), "outbound", "c", null, null, createdAt.toString());
        store.save(answer, new byte[0]);
        return answer;
    }

    static InterceptionRule ruleUsing(String answerId) {
        RuleAction action = new ObjectMapper().convertValue(
                Map.of("type", ActionType.ANSWER_WITH_RECORDED_CALL.name(), "answerId", answerId), RuleAction.class);
        return new InterceptionRule("r-" + answerId, "Replay", null, true, 10, false, RuleMatch.empty(),
                List.of(action), null, null);
    }
}
