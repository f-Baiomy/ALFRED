package com.fathy.alfred.backend.interception.application.service;

import com.fathy.alfred.backend.interception.application.port.in.ManageStoredAnswersUseCase;
import com.fathy.alfred.backend.interception.application.port.out.InterceptionRulesStorePort;
import com.fathy.alfred.backend.interception.application.port.out.RecordedCallLookupPort;
import com.fathy.alfred.backend.interception.application.port.out.RulesPublisherPort.PublishedAnswer;
import com.fathy.alfred.backend.interception.application.port.out.StoredAnswersStorePort;
import com.fathy.alfred.backend.interception.domain.model.InterceptionRule;
import com.fathy.alfred.backend.interception.domain.model.SensitiveHeaders;
import com.fathy.alfred.backend.interception.domain.model.StoredAnswer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

/**
 * Stored answers: copying a logged response into one, the keep/strip decision on its secrets, and
 * deleting answers no rule needs any more.
 *
 * <p>An answer is deleted in exactly two ways. When a save means a rule that referred to it no
 * longer does ({@link #release}); and by the sweep, for an answer nothing has referred to for an
 * hour. It is deliberately NOT "delete everything unreferenced on every save": an answer is created
 * the moment a call is picked in the editor, before the rule that will use it is saved, and a save
 * in another tab in between would otherwise delete it from under the editor.
 */
@Service
public class StoredAnswersService implements ManageStoredAnswersUseCase {

    private static final Logger log = LoggerFactory.getLogger(StoredAnswersService.class);

    /** How long an answer nothing refers to is kept, so one picked in the editor survives until saved. */
    static final Duration ORPHAN_GRACE = Duration.ofHours(1);

    /**
     * Headers that describe how the ORIGINAL bytes were framed on the wire. The logged body is the
     * decoded text, so replaying these would promise a gzip body or a length that is no longer
     * true - the caller would fail to decode the answer.
     */
    private static final Set<String> FRAMING_HEADERS = Set.of(
            "content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive");

    private final StoredAnswersStorePort store;
    private final RecordedCallLookupPort calls;
    private final InterceptionRulesStorePort rules;
    private final long maxAnswerBytes;
    private final Clock clock;

    @Autowired
    public StoredAnswersService(StoredAnswersStorePort store,
                                RecordedCallLookupPort calls,
                                InterceptionRulesStorePort rules,
                                @Value("${alfred.interception.max-answer-bytes:10485760}") long maxAnswerBytes) {
        this(store, calls, rules, maxAnswerBytes, Clock.systemUTC());
    }

    StoredAnswersService(StoredAnswersStorePort store, RecordedCallLookupPort calls,
                         InterceptionRulesStorePort rules, long maxAnswerBytes, Clock clock) {
        this.store = store;
        this.calls = calls;
        this.rules = rules;
        this.maxAnswerBytes = maxAnswerBytes;
        this.clock = clock;
    }

    @Override
    public CopyResult copyFromCall(String direction, String callId, String cycleId, Boolean keepSecrets) {
        Optional<RecordedCallLookupPort.RecordedResponse> found = calls.find(direction, callId, cycleId);
        if (found.isEmpty()) {
            return new CopyResult.NotFound();
        }
        RecordedCallLookupPort.RecordedResponse response = found.get();
        if (response.body().length > maxAnswerBytes) {
            return new CopyResult.TooLarge(maxAnswerBytes, response.body().length);
        }

        List<String> secretNames = response.headers().keySet().stream()
                .filter(SensitiveHeaders::isSensitive)
                .map(name -> name.toLowerCase(Locale.ROOT))
                .distinct()
                .sorted()
                .toList();
        if (!secretNames.isEmpty() && keepSecrets == null) {
            return new CopyResult.SecretsDecisionRequired(secretNames);
        }
        boolean strip = !secretNames.isEmpty() && !keepSecrets;

        Map<String, String> headers = new LinkedHashMap<>();
        response.headers().forEach((name, value) -> {
            String lower = name.toLowerCase(Locale.ROOT);
            if (FRAMING_HEADERS.contains(lower) || (strip && SensitiveHeaders.isSensitive(lower))) {
                return;
            }
            headers.put(name, value);
        });
        String contentType = headers.entrySet().stream()
                .filter(e -> e.getKey().equalsIgnoreCase("content-type"))
                .map(Map.Entry::getValue)
                .findFirst().orElse(null);

        String now = Instant.now(clock).toString();
        StoredAnswer answer = new StoredAnswer(
                UUID.randomUUID().toString(), StoredAnswer.Kind.RECORDED, response.status(), headers, contentType,
                response.body().length,
                secretNames.isEmpty() ? null : keepSecrets,
                secretNames, direction, callId, cycleId,
                headerValue(response.headers(), "date"), now);
        store.save(answer, response.body());
        return new CopyResult.Created(answer);
    }

    @Override
    public Optional<AnswerView> get(String id) {
        if (!StoredAnswer.isValidId(id)) {
            return Optional.empty();
        }
        return store.findMeta(id).map(answer -> new AnswerView(answer, rules.findAll().stream()
                .filter(rule -> rule.answerIds().contains(id))
                .map(InterceptionRule::id)
                .toList()));
    }

    @Override
    public Optional<byte[]> body(String id) {
        return StoredAnswer.isValidId(id) ? store.findBody(id) : Optional.empty();
    }

    @Override
    public Optional<StoredAnswer> importAnswer(StoredAnswer answer, byte[] body) {
        if (body == null || body.length > maxAnswerBytes) {
            return Optional.empty();
        }
        // Re-derived rather than trusted: a file is untrusted input, and what it says about its own
        // secrets must match the headers it actually carries.
        Map<String, String> headers = new LinkedHashMap<>();
        answer.headers().forEach((name, value) -> {
            if (!FRAMING_HEADERS.contains(name.toLowerCase(Locale.ROOT))) {
                headers.put(name, value);
            }
        });
        List<String> secretNames = headers.keySet().stream().filter(SensitiveHeaders::isSensitive)
                .map(name -> name.toLowerCase(Locale.ROOT)).distinct().sorted().toList();
        StoredAnswer fresh = new StoredAnswer(UUID.randomUUID().toString(), answer.kind(), answer.status(), headers,
                answer.contentType(), body.length, secretNames.isEmpty() ? null : Boolean.TRUE, secretNames,
                answer.sourceDirection(), null, null, answer.recordedAt(), Instant.now(clock).toString());
        store.save(fresh, body);
        return Optional.of(fresh);
    }

    /** The kind of an existing answer, for RuleValidator. */
    public Optional<StoredAnswer.Kind> kindOf(String id) {
        return store.findMeta(id).map(StoredAnswer::kind);
    }

    /** Metadata plus a lazy body for each answer the given rules use - what the publisher writes. */
    public List<PublishedAnswer> publishable(Set<String> ids) {
        List<PublishedAnswer> out = new ArrayList<>();
        for (String id : ids) {
            store.findMeta(id).ifPresent(meta -> out.add(new PublishedAnswer(meta,
                    () -> store.findBody(id).orElse(new byte[0]))));
        }
        return out;
    }

    /** Deletes the answers a save stopped referring to: in {@code before}, absent from {@code after}. */
    public void release(Set<String> before, Set<String> after) {
        for (String id : before) {
            if (!after.contains(id)) {
                store.delete(id);
            }
        }
    }

    /**
     * Deletes answers no rule refers to and that are older than the grace period - picked in an
     * editor that was then closed without saving, or imported with a rule that was rejected.
     */
    @Scheduled(fixedDelay = 600_000, initialDelay = 600_000)
    public void sweepOrphans() {
        Set<String> referenced = InterceptionRule.answerIdsOf(rules.findAll());
        Instant cutoff = Instant.now(clock).minus(ORPHAN_GRACE);
        for (StoredAnswer answer : store.listMeta()) {
            if (referenced.contains(answer.id()) || !olderThan(answer.createdAt(), cutoff)) {
                continue;
            }
            store.delete(answer.id());
            log.info("Deleted stored answer {} - no rule has used it for over {}", answer.id(), ORPHAN_GRACE);
        }
    }

    private static boolean olderThan(String createdAt, Instant cutoff) {
        try {
            return createdAt != null && Instant.parse(createdAt).isBefore(cutoff);
        } catch (DateTimeParseException e) {
            // An unreadable timestamp is treated as old: keeping it forever is the worse failure.
            return true;
        }
    }

    private static String headerValue(Map<String, String> headers, String name) {
        return headers.entrySet().stream()
                .filter(e -> e.getKey().equalsIgnoreCase(name))
                .map(Map.Entry::getValue)
                .findFirst().orElse(null);
    }
}
