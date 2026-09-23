package com.fathy.alfred.backend.interception.application.port.in;

import com.fathy.alfred.backend.interception.domain.model.StoredAnswer;

import java.util.List;
import java.util.Optional;

/** Creating and reading the responses a rule can answer with. */
public interface ManageStoredAnswersUseCase {

    /**
     * Copies a logged call's response into a new stored answer.
     *
     * @param keepSecrets null until the user has decided; a response carrying secret headers then
     *                    comes back as {@link CopyResult.SecretsDecisionRequired} rather than being
     *                    stored either way on their behalf.
     */
    CopyResult copyFromCall(String direction, String callId, String cycleId, Boolean keepSecrets);

    Optional<AnswerView> get(String id);

    Optional<byte[]> body(String id);

    /** A stored answer from a rules file, under a fresh id. Refused (empty) when over the size cap. */
    Optional<StoredAnswer> importAnswer(StoredAnswer answer, byte[] body);

    /** The answer plus which rules use it - what the editor shows under an answer action. */
    record AnswerView(StoredAnswer answer, List<String> referencedByRuleIds) {
    }

    sealed interface CopyResult {
        record Created(StoredAnswer answer) implements CopyResult {
        }

        record SecretsDecisionRequired(List<String> secretNames) implements CopyResult {
        }

        record NotFound() implements CopyResult {
        }

        record TooLarge(long limitBytes, long sizeBytes) implements CopyResult {
        }
    }
}
