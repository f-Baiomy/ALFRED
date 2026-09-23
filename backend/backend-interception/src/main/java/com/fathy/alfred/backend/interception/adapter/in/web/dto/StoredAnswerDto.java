package com.fathy.alfred.backend.interception.adapter.in.web.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fathy.alfred.backend.interception.application.port.in.ManageStoredAnswersUseCase.AnswerView;
import com.fathy.alfred.backend.interception.domain.model.StoredAnswer;

import java.util.List;

/**
 * A stored answer as the editor sees it: metadata and who uses it. Never the headers' values and
 * never the body - the body has its own route, and the secret names are names only.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record StoredAnswerDto(
        String id,
        StoredAnswer.Kind kind,
        Integer status,
        String contentType,
        long sizeBytes,
        Boolean secretsKept,
        List<String> secretNames,
        String sourceDirection,
        String sourceCallId,
        String recordedAt,
        String createdAt,
        List<String> referencedByRuleIds) {

    public static StoredAnswerDto of(StoredAnswer answer, List<String> referencedByRuleIds) {
        return new StoredAnswerDto(answer.id(), answer.kind(), answer.status(), answer.contentType(),
                answer.sizeBytes(), answer.secretsKept(), answer.secretNames(), answer.sourceDirection(),
                answer.sourceCallId(), answer.recordedAt(), answer.createdAt(), referencedByRuleIds);
    }

    public static StoredAnswerDto of(AnswerView view) {
        return of(view.answer(), view.referencedByRuleIds());
    }
}
