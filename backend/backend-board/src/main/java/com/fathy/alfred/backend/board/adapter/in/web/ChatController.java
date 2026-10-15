package com.fathy.alfred.backend.board.adapter.in.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fathy.alfred.backend.board.application.port.in.ChatUseCase;
import com.fathy.alfred.backend.board.application.port.in.ChatUseCase.Result;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.ChatKey;
import com.fathy.alfred.backend.board.domain.model.ChatMessage;
import com.fathy.alfred.backend.board.domain.model.ChatRecord;
import com.fathy.alfred.backend.board.domain.model.ChatSettings;
import com.fathy.alfred.backend.board.domain.model.ChatWatch;
import com.fathy.alfred.backend.board.domain.model.MentionRef;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/**
 * /board/chats (specs/022 contracts/rest-api.md). Every write goes through BoardEditAccessInterceptor like the rest of
 * /board, so the tunnel only reads. Claude's writes carry {@code X-Alfred-Actor: claude} and are held to its limits in
 * the service.
 */
@RestController
public class ChatController {

    private final ChatUseCase chats;

    public ChatController(ChatUseCase chats) {
        this.chats = chats;
    }

    private static ChatKey key(String project, String scope) {
        return ChatKey.of(project, scope);
    }

    private static <T> ResponseEntity<?> respond(Result<T> r, Function<T, Object> view) {
        return r.isOk() ? ResponseEntity.ok(r.value() == null ? Map.of() : view.apply(r.value())) : BoardWeb.refused(r.outcome(), r.message());
    }

    // ------------------------------------------------------------------------------------------------------------ reads

    @GetMapping("/board/chats")
    public ResponseEntity<?> chats(@RequestParam(defaultValue = "") String project) {
        return ResponseEntity.ok(chats.chats(project).stream().map(ChatViews::summary).toList());
    }

    @GetMapping("/board/chats/{scope}/messages")
    public ResponseEntity<?> page(@PathVariable String scope, @RequestParam(defaultValue = "") String project,
                                  @RequestParam(required = false) Long before, @RequestParam(defaultValue = "50") int limit) {
        int n = Math.max(1, Math.min(limit, ChatUseCase.MAX_PAGE));
        ChatUseCase.Page page = chats.page(key(project, scope), before, n);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("messages", page.messages().stream().map(m -> ChatViews.message(m, page.records().get(m.id()))).toList());
        out.put("more", page.more());
        return ResponseEntity.ok(out);
    }

    /** The board export's chat records, page by page (specs/022 T052): {@code cycleId} for one cycle's chat, else every chat. */
    @GetMapping("/board/chats/export")
    public ResponseEntity<?> export(@RequestParam(defaultValue = "") String project, @RequestParam(required = false) String cycleId,
                                    @RequestParam(defaultValue = "0") long after, @RequestParam(defaultValue = "200") int limit) {
        ChatUseCase.ExportPage page = chats.exportChats(project, cycleId == null || cycleId.isBlank() ? null : cycleId.strip(), Math.max(0, after), limit);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("lines", page.lines());
        out.put("next", page.next());
        out.put("more", page.more());
        return ResponseEntity.ok(out);
    }

    @GetMapping("/board/chats/messages/{id}")
    public ResponseEntity<?> message(@PathVariable long id) {
        return chats.message(id).<ResponseEntity<?>>map(m -> ResponseEntity.ok(ChatViews.message(m)))
                .orElseGet(() -> BoardWeb.refused(com.fathy.alfred.backend.board.domain.model.CardChange.Outcome.NOT_FOUND, "No chat message " + id));
    }

    @GetMapping("/board/chats/messages/{id}/answer")
    public ResponseEntity<?> answer(@PathVariable long id) {
        return chats.answerOf(id).<ResponseEntity<?>>map(m -> ResponseEntity.ok(ChatViews.message(m)))
                .orElseGet(() -> BoardWeb.refused(com.fathy.alfred.backend.board.domain.model.CardChange.Outcome.NOT_FOUND,
                        "Message " + id + " has no answer yet"));
    }

    @GetMapping("/board/chats/{scope}/search")
    public ResponseEntity<?> search(@PathVariable String scope, @RequestParam(defaultValue = "") String project,
                                    @RequestParam(defaultValue = "") String q, @RequestParam(defaultValue = "all") String filter) {
        return ResponseEntity.ok(Map.of("hits", chats.search(key(project, scope), q, filter)));
    }

    @GetMapping("/board/chats/{scope}/shared")
    public ResponseEntity<?> shared(@PathVariable String scope, @RequestParam(defaultValue = "") String project) {
        return ResponseEntity.ok(Map.of("groups", chats.shared(key(project, scope))));
    }

    /** "While you were away" (FR-023): 204 when nothing changed since {@code since} (epoch ms). */
    @GetMapping("/board/chats/{scope}/digest")
    public ResponseEntity<?> digest(@PathVariable String scope, @RequestParam(defaultValue = "") String project, @RequestParam long since) {
        return chats.digest(key(project, scope), Instant.ofEpochMilli(Math.max(0, since)))
                .<ResponseEntity<?>>map(d -> ResponseEntity.ok(Map.of("lines", d.lines(), "since", d.since())))
                .orElseGet(() -> ResponseEntity.noContent().build());
    }

    @GetMapping("/board/chats/{scope}/watches")
    public ResponseEntity<?> watches(@PathVariable String scope, @RequestParam(defaultValue = "") String project) {
        return ResponseEntity.ok(chats.watches(key(project, scope)).stream().map(ChatViews::watch).toList());
    }

    @GetMapping("/board/chats/{scope}/settings")
    public ResponseEntity<?> settings(@PathVariable String scope, @RequestParam(defaultValue = "") String project) {
        return ResponseEntity.ok(ChatViews.settings(chats.settings(key(project, scope))));
    }

    @GetMapping("/board/chats/{scope}/terminal")
    public ResponseEntity<?> terminal(@PathVariable String scope, @RequestParam(defaultValue = "") String project) {
        return ResponseEntity.ok(chats.terminal(key(project, scope)).stream().map(ChatViews::terminal).toList());
    }

    @GetMapping("/board/chats/{scope}/context")
    public ResponseEntity<?> context(@PathVariable String scope, @RequestParam(defaultValue = "") String project) {
        ChatUseCase.Handover h = chats.handover(key(project, scope));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("summary", h.summary() == null ? null : ChatViews.message(h.summary()));
        out.put("after", h.after().stream().map(ChatViews::message).toList());
        out.put("decisions", h.decisions().stream().map(ChatViews::message).toList());
        out.put("terminal", h.terminal().stream().map(ChatViews::terminal).toList());
        out.put("session", h.session() == null ? null : Map.of("chatSessionId", String.valueOf(h.session().chatSessionId()),
                "host", String.valueOf(h.session().host())));
        return ResponseEntity.ok(out);
    }

    // ----------------------------------------------------------------------------------------------------- user writes

    public record MentionDto(@NotBlank @Size(max = 20) String type, @NotBlank @Size(max = 2000) String ref, @Size(max = 300) String label) {
    }

    public record PostDto(@Size(max = ChatMessage.MAX_TEXT) String text, Long parentId, @Size(max = 10) List<@Valid MentionDto> context,
                          @Size(max = 4000) String quote, Boolean urgent, @Size(max = 60) String origin, @Size(max = 20) List<@Size(max = 100) String> imageIds) {
    }

    @PostMapping("/board/chats/{scope}/messages")
    public ResponseEntity<?> post(@PathVariable String scope, @RequestParam(defaultValue = "") String project, @Valid @RequestBody PostDto body,
                                  @RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor) {
        List<MentionRef> context;
        try {
            context = body.context() == null ? List.of() : body.context().stream()
                    .map(c -> BoardWeb.ref(c.type(), c.ref(), c.label() == null ? c.ref() : c.label())).toList();
        } catch (IllegalArgumentException e) {
            return BoardWeb.refused(com.fathy.alfred.backend.board.domain.model.CardChange.Outcome.INVALID, "Unknown mention type");
        }
        return respond(chats.post(BoardWeb.actor(actor), key(project, scope), new ChatUseCase.Post(body.text(), body.parentId(), context,
                body.quote(), Boolean.TRUE.equals(body.urgent()), body.origin(), body.imageIds())), ChatViews::message);
    }

    public record EditDto(@NotNull @Size(max = ChatMessage.MAX_TEXT) String text) {
    }

    @PatchMapping("/board/chats/messages/{id}")
    public ResponseEntity<?> edit(@PathVariable long id, @Valid @RequestBody EditDto body,
                                  @RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor) {
        return respond(chats.edit(BoardWeb.actor(actor), id, body.text()), ChatViews::message);
    }

    @PostMapping("/board/chats/messages/{id}/cancel")
    public ResponseEntity<?> cancel(@PathVariable long id, @RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor) {
        return respond(chats.cancel(BoardWeb.actor(actor), id), ChatViews::message);
    }

    public record DecisionDto(boolean on) {
    }

    @PostMapping("/board/chats/messages/{id}/decision")
    public ResponseEntity<?> decision(@PathVariable long id, @RequestBody DecisionDto body,
                                      @RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor) {
        return respond(chats.decision(BoardWeb.actor(actor), id, body.on()), ChatViews::message);
    }

    public record ReactDto(@NotBlank @Size(max = 16) String emoji) {
    }

    @PostMapping("/board/chats/messages/{id}/react")
    public ResponseEntity<?> react(@PathVariable long id, @Valid @RequestBody ReactDto body,
                                   @RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor) {
        return respond(chats.react(BoardWeb.actor(actor), id, body.emoji()), ChatViews::message);
    }

    public record AnswersDto(@jakarta.validation.constraints.NotNull @Size(max = 20) Map<@Size(max = 200) String, @Size(max = 2000) String> answers) {
    }

    @PostMapping("/board/chats/messages/{id}/answers")
    public ResponseEntity<?> answers(@PathVariable long id, @Valid @RequestBody AnswersDto body,
                                     @RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor) {
        return respond(chats.answer(BoardWeb.actor(actor), id, body.answers()), ChatViews::message);
    }

    public record AgainDto(Boolean logs, Boolean sql, Boolean items, @Size(max = 4000) String text) {
    }

    @PostMapping("/board/chats/messages/{id}/again")
    public ResponseEntity<?> again(@PathVariable long id, @Valid @RequestBody AgainDto body,
                                   @RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor) {
        return respond(chats.again(BoardWeb.actor(actor), id, new ChatUseCase.AskAgain(Boolean.TRUE.equals(body.logs()),
                Boolean.TRUE.equals(body.sql()), Boolean.TRUE.equals(body.items()), body.text())), ChatViews::message);
    }

    @PostMapping("/board/chats/messages/{id}/urgent")
    public ResponseEntity<?> urgent(@PathVariable long id, @RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor) {
        return respond(chats.urgent(BoardWeb.actor(actor), id), ChatViews::message);
    }

    @PostMapping("/board/chats/{scope}/compact")
    public ResponseEntity<?> compact(@PathVariable String scope, @RequestParam(defaultValue = "") String project,
                                     @RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor) {
        return respond(chats.compact(BoardWeb.actor(actor), key(project, scope)), ChatViews::message);
    }

    public record SettingsDto(@Min(0) @Max(ChatSettings.MAX_AUTO_N) int autoN, @Min(ChatSettings.MIN_DIGEST_GAP_MIN)
                              @Max(ChatSettings.MAX_DIGEST_GAP_MIN) int digestGapMin, boolean watching) {
    }

    @PutMapping("/board/chats/{scope}/settings")
    public ResponseEntity<?> putSettings(@PathVariable String scope, @RequestParam(defaultValue = "") String project,
                                         @Valid @RequestBody SettingsDto body,
                                         @RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor) {
        ChatSettings s;
        try {
            s = new ChatSettings(key(project, scope), body.autoN(), body.digestGapMin(), body.watching());
        } catch (IllegalArgumentException e) {
            return BoardWeb.refused(com.fathy.alfred.backend.board.domain.model.CardChange.Outcome.INVALID, e.getMessage());
        }
        return respond(chats.putSettings(BoardWeb.actor(actor), s), ChatViews::settings);
    }

    @PostMapping("/board/chats/records/{id}/undo")
    public ResponseEntity<?> undoRecord(@PathVariable long id, @RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor) {
        return respond(chats.undoRecord(BoardWeb.actor(actor), id), v -> Map.of());
    }

    @PostMapping("/board/chats/terminal/{id}/undo")
    public ResponseEntity<?> undoTerminal(@PathVariable long id, @RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor) {
        return respond(chats.undoTerminal(BoardWeb.actor(actor), id), v -> Map.of());
    }

    @PostMapping("/board/chats/{scope}/refresh")
    public ResponseEntity<?> refresh(@PathVariable String scope, @RequestParam(defaultValue = "") String project,
                                     @RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor) {
        return respond(chats.refresh(BoardWeb.actor(actor), key(project, scope)), v -> Map.of());
    }

    @DeleteMapping("/board/chats/watches/{id}")
    public ResponseEntity<?> cancelWatch(@PathVariable long id, @RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor) {
        return respond(chats.cancelWatch(BoardWeb.actor(actor), id), v -> Map.of());
    }

    // -------------------------------------------------------------------------------------------------- Claude's writes

    public record TakeDto(@NotBlank @Size(max = 100) String chatId, @Size(max = 100) String cycleId) {
    }

    @PostMapping("/board/chats/messages/{id}/take")
    public ResponseEntity<?> take(@PathVariable long id, @Valid @RequestBody TakeDto body,
                                  @RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor) {
        return respond(chats.take(BoardWeb.actor(actor), id, body.chatId().strip(), body.cycleId()), t -> {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("message", ChatViews.message(t.message()));
            out.put("thread", t.thread().stream().map(ChatViews::message).toList());
            out.put("summary", t.summary() == null ? null : ChatViews.message(t.summary()));
            return out;
        });
    }

    public record CardPartDto(@Size(max = 20) String kind, @Size(max = 200) String title, @Size(max = ChatMessage.MAX_TEXT) String description) {
    }

    public record ItemPartDto(@Size(max = 200) String file, @Size(max = 4000) String text, @Size(max = 4000) String evidence) {
    }

    public record FixPartDto(@Min(1) int card, @Size(max = ChatMessage.MAX_TEXT) String report, @Size(max = 16 * 1024) String plan) {
    }

    public record RecordDto(@NotNull ChatRecord.Kind kind, @NotBlank @Size(max = 8000) String text, @Valid CardPartDto card,
                            @Valid ItemPartDto item, @Valid FixPartDto fix) {
    }

    public record TerminalDto(@NotBlank @Size(max = 16 * 1024) String text, boolean urgent, @Size(max = 40) String reason, Boolean mirror) {
    }

    public record ReplyDto(@NotBlank @Size(max = ChatMessage.MAX_TEXT) String text, @Size(max = 20) List<@Valid RecordDto> records,
                           @Size(max = 11) List<@Valid TerminalDto> toTerminal, JsonNode extra, Long updateId) {
    }

    @PostMapping("/board/chats/messages/{id}/reply")
    public ResponseEntity<?> reply(@PathVariable long id, @Valid @RequestBody ReplyDto body,
                                   @RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor) {
        if (body.extra() != null && body.extra().toString().length() > 256 * 1024) {
            return BoardWeb.refused(com.fathy.alfred.backend.board.domain.model.CardChange.Outcome.INVALID, "extra is larger than 256 KB");
        }
        List<ChatUseCase.RecordRequest> records = body.records() == null ? List.of() : body.records().stream().map(r -> new ChatUseCase.RecordRequest(
                r.kind(), r.text(), r.card() == null ? null : new ChatUseCase.NewCardPart(r.card().kind(), r.card().title(), r.card().description()),
                r.item() == null ? null : new ChatUseCase.ItemPart(r.item().file(), r.item().text(), r.item().evidence()),
                r.fix() == null ? null : new ChatUseCase.FixPart(r.fix().card(), r.fix().report(), r.fix().plan()))).toList();
        return respond(chats.reply(BoardWeb.actor(actor), id, new ChatUseCase.Reply(body.text(), records, terminal(body.toTerminal()), body.extra(),
                body.updateId())), r -> {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("message", ChatViews.message(r.message(), r.records()));
            out.put("records", r.records().stream().map(ChatViews::record).toList());
            out.put("terminal", r.terminal().stream().map(ChatViews::terminal).toList());
            return out;
        });
    }

    private static List<ChatUseCase.ToTerminal> terminal(List<TerminalDto> items) {
        return items == null ? List.of() : items.stream().map(t -> new ChatUseCase.ToTerminal(t.text(), t.urgent(), t.reason(),
                Boolean.TRUE.equals(t.mirror()))).toList();
    }

    public record SummaryDto(@NotBlank @Size(max = ChatMessage.MAX_TEXT) String text, @Min(1) long coversTo) {
    }

    @PostMapping("/board/chats/{scope}/summary")
    public ResponseEntity<?> summary(@PathVariable String scope, @RequestParam(defaultValue = "") String project, @Valid @RequestBody SummaryDto body,
                                     @RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor) {
        return respond(chats.summary(BoardWeb.actor(actor), key(project, scope), body.text(), body.coversTo()), ChatViews::message);
    }

    public record SessionDto(@NotBlank @Size(max = 200) String chatSessionId, @Size(max = 200) String forkedFrom, @Size(max = 200) String host,
                             Instant forkedAt, Instant seenUpTo) {
    }

    @PutMapping("/board/chats/{scope}/session")
    public ResponseEntity<?> session(@PathVariable String scope, @RequestParam(defaultValue = "") String project, @Valid @RequestBody SessionDto body,
                                     @RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor) {
        return respond(chats.putSession(BoardWeb.actor(actor), key(project, scope), body.chatSessionId(), body.forkedFrom(), body.host(),
                body.forkedAt(), body.seenUpTo()), s -> Map.of("chatSessionId", s.chatSessionId()));
    }

    public record TerminalItemsDto(@NotNull @Size(min = 1, max = 10) List<@Valid TerminalDto> items) {
    }

    @PostMapping("/board/chats/{scope}/terminal")
    public ResponseEntity<?> addTerminal(@PathVariable String scope, @RequestParam(defaultValue = "") String project,
                                         @Valid @RequestBody TerminalItemsDto body,
                                         @RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor) {
        return respond(chats.addTerminal(BoardWeb.actor(actor), key(project, scope), terminal(body.items())),
                items -> items.stream().map(ChatViews::terminal).toList());
    }

    public record DeliveredDto(@NotNull @Size(max = 500) List<Long> ids, boolean read) {
    }

    @PostMapping("/board/chats/terminal/delivered")
    public ResponseEntity<?> delivered(@Valid @RequestBody DeliveredDto body,
                                       @RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor) {
        return respond(chats.delivered(BoardWeb.actor(actor), body.ids(), body.read()), v -> Map.of());
    }

    public record ReleaseDto(boolean failed, @Size(max = 2000) String why) {
    }

    @PostMapping("/board/chats/messages/{id}/release")
    public ResponseEntity<?> release(@PathVariable long id, @Valid @RequestBody ReleaseDto body,
                                     @RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor) {
        return respond(chats.release(BoardWeb.actor(actor), id, body.failed(), body.why()), ChatViews::message);
    }

    public record SystemDto(@NotBlank @Size(max = 500) String text) {
    }

    @PostMapping("/board/chats/{scope}/system")
    public ResponseEntity<?> system(@PathVariable String scope, @RequestParam(defaultValue = "") String project, @Valid @RequestBody SystemDto body,
                                    @RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor) {
        return respond(chats.systemLine(BoardWeb.actor(actor), key(project, scope), body.text()), ChatViews::message);
    }

    public record WatchDto(@NotNull ChatWatch.Kind kind, @NotBlank @Size(max = 200) String target, @NotBlank @Size(max = 200) String label,
                           Long messageId) {
    }

    @PostMapping("/board/chats/{scope}/watches")
    public ResponseEntity<?> watch(@PathVariable String scope, @RequestParam(defaultValue = "") String project, @Valid @RequestBody WatchDto body,
                                   @RequestHeader(value = BoardWeb.ACTOR_HEADER, required = false) String actor) {
        return respond(chats.watch(BoardWeb.actor(actor), key(project, scope), body.kind(), body.target(), body.label(), body.messageId()),
                ChatViews::watch);
    }
}
