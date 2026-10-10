package com.fathy.alfred.backend.board.adapter.in.web.dto;

import com.fathy.alfred.backend.board.application.port.in.BulkCardsUseCase;
import com.fathy.alfred.backend.board.domain.model.AgentStatus;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.Flag;
import com.fathy.alfred.backend.board.domain.model.Mark;
import com.fathy.alfred.backend.board.domain.model.Resolution;
import com.fathy.alfred.backend.board.domain.model.Scope;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.util.List;
import java.util.Set;

/** Request bodies of /board (contracts/rest-api.md). Sizes match the store's seatbelts (research R17). */
public final class BoardRequests {

    public static final int MAX_TEXT = 256 * 1024;
    public static final String MENTION_TYPES = "(?i)call|stmt|log|redis|spec|code|cycle|spacer|card|rule";

    private BoardRequests() {
    }

    public record LinkRequestDto(@NotBlank @Pattern(regexp = MENTION_TYPES) String type, @NotBlank @Size(max = 1000) String ref,
                                 @NotBlank @Size(max = 200) String label) {
    }

    public record CreateCardRequestDto(@Size(max = 100) String project, @NotNull CardKind kind, @NotBlank @Size(max = 300) String title,
                                       @Size(max = MAX_TEXT) String description, Set<Flag> flags, @Size(max = 200) String cycleId,
                                       CardStatus status, @Size(max = 100) List<@Valid LinkRequestDto> links) {
    }

    public record QuickAddRequestDto(@Size(max = 100) String project, @Size(max = 200) String cycleId,
                                     @NotBlank @Size(max = 1000) String text) {
    }

    public record UpdateCardRequestDto(@Size(min = 1, max = 300) String title, @Size(max = MAX_TEXT) String description, CardKind kind,
                                       Set<Flag> flags, Scope scope, @Size(max = 200) String cycleId, @Size(max = 100) String project) {
    }

    public record MoveCardRequestDto(@NotNull CardStatus status) {
    }

    public record CloseCardRequestDto(@NotNull Resolution resolution, @Size(max = 2000) String reason) {
    }

    public record ReasonRequestDto(@Size(max = 2000) String reason) {
    }

    public record BulkRequestDto(@NotEmpty @Size(max = BulkCardsUseCase.MAX_CARDS) List<@NotBlank String> ids,
                                 @NotNull BulkCardsUseCase.Action action, @Size(max = 2000) String reason) {
    }

    public record CommentRequestDto(@Size(max = MAX_TEXT) String text, @Size(max = MAX_TEXT) String did,
                                    @Size(max = MAX_TEXT) String found, @Size(max = MAX_TEXT) String next,
                                    @Size(max = MAX_TEXT) String impact) {
    }

    public record UnlinkRequestDto(@NotBlank @Pattern(regexp = MENTION_TYPES) String type, @NotBlank @Size(max = 1000) String ref) {
    }

    public record AgentStatusRequestDto(@Size(max = 100) String project, @Size(max = 200) String cycleId, AgentStatus.State state,
                                        @Min(0) @Max(10_000_000) int callsChecked, @Min(0) @Max(10_000_000) int cardsAdded) {
    }

    public record ProjectRequestDto(@Size(max = 100) String project) {
    }

    public record BriefRequestDto(@Size(max = MAX_TEXT) String text) {
    }

    public record MarkRequestDto(@NotNull Mark mark, @Size(max = 8 * 1024) String evidence) {
    }
}
