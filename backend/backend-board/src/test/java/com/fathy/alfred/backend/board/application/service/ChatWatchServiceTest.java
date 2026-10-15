package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.ChatUseCase.Post;
import com.fathy.alfred.backend.board.application.port.in.ChatUseCase.Reply;
import com.fathy.alfred.backend.board.application.port.in.RequirementUseCase;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CallFacts;
import com.fathy.alfred.backend.board.domain.model.ChatKey;
import com.fathy.alfred.backend.board.domain.model.ChatMessage;
import com.fathy.alfred.backend.board.domain.model.ChatSettings;
import com.fathy.alfred.backend.board.domain.model.ChatWatch;
import com.fathy.alfred.backend.board.domain.model.ItemVerdict;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** specs/022 US8: "tell me when" fires once on its event; "watch while I test" queues one batch per chat while Claude is on. */
class ChatWatchServiceTest {

    private static final ChatKey CYCLE = new ChatKey("odeysys", "c-1");

    @TempDir
    Path dir;

    private BoardFixture f;
    private final RequirementUseCase requirements = mock(RequirementUseCase.class);
    private ChatWatchService watches;

    @BeforeEach
    void setUp() {
        f = new BoardFixture(dir);
        watches = new ChatWatchService(f.chatStore, f.factsPort, () -> requirements, () -> f.live, f.notifications, f.feed, f.clock, Runnable::run);
    }

    @AfterEach
    void tearDown() throws Exception {
        f.close();
    }

    private ChatWatch watch(ChatWatch.Kind kind, String target, String label) {
        var r = f.chat.watch(Actor.CLAUDE, CYCLE, kind, target, label, null);
        assertThat(r.isOk()).as(r.message()).isTrue();
        return r.value();
    }

    private List<ChatMessage> lines() {
        return f.chat.page(CYCLE, null, 100).messages().stream().filter(m -> m.kind() == ChatMessage.Kind.SYSTEM).toList();
    }

    @Test
    void aStatusWatchFiresOnceOnTheFirstMatchingCall() {
        watch(ChatWatch.Kind.STATUS, "5xx", "tell me when a 5xx comes");
        watches.callCompleted("odeysys", "a1", "POST /api/search", 200);
        assertThat(lines()).isEmpty();
        watches.callCompleted("odeysys", "a2", "POST /api/search", 503);
        watches.callCompleted("odeysys", "a3", "POST /api/search", 500);
        assertThat(lines()).singleElement().extracting(ChatMessage::text).asString()
                .contains("tell me when a 5xx comes").contains("@[call:in:a2|POST /api/search · 503]");
        assertThat(f.chatStore.watches("odeysys")).isEmpty();
        watches.callCompleted("other", "b", "GET /", 500);
    }

    @Test
    void anErrorLogWatchFiresOnlyForItsEndpointWhenAnErrorWasLogged() {
        watch(ChatWatch.Kind.ERROR_LOG, "/orders", "an error on orders");
        f.facts.put("x1", new CallFacts(200, 10.0, 0, Map.of(), 0, 0, Map.of()));
        f.facts.put("x2", new CallFacts(200, 10.0, 0, Map.of(), 1, 0, Map.of()));
        watches.callCompleted("odeysys", "x2", "GET /api/search", 200);
        watches.callCompleted("odeysys", "x1", "POST /api/orders", 200);
        assertThat(lines()).isEmpty();
        f.facts.put("x3", new CallFacts(200, 10.0, 0, Map.of(), 2, 0, Map.of()));
        watches.callCompleted("odeysys", "x3", "POST /api/orders", 200);
        assertThat(lines()).singleElement().extracting(ChatMessage::text).asString().contains("ERROR").contains("x3");
    }

    @Test
    void anItemWatchFiresWhenItsVerdictIsMetOnTheBoardsSignal() {
        watch(ChatWatch.Kind.ITEM_PASSES, "AC2", "tell me when AC2 passes");
        RequirementUseCase.Requirement one = new RequirementUseCase.Requirement("spec.md", "k1", "first", null, null, null, null, null, null);
        RequirementUseCase.Requirement two = new RequirementUseCase.Requirement("spec.md", "k2", "second", null, null,
                new ItemVerdict("c-1", "spec.md", "k2", ItemVerdict.Verdict.NO_DATA, null, null, ItemVerdict.Counts.NONE, null, null), null, null, null);
        when(requirements.requirements("c-1")).thenReturn(new RequirementUseCase.Requirements("c-1", List.of(one, two), Map.of()));
        f.feed.observed("odeysys", "c-1", null, "requirements");
        assertThat(lines()).isEmpty();

        RequirementUseCase.Requirement met = new RequirementUseCase.Requirement("spec.md", "k2", "second", null, null,
                new ItemVerdict("c-1", "spec.md", "k2", ItemVerdict.Verdict.MET, "call9", null, ItemVerdict.Counts.NONE, null, null), null, null, null);
        when(requirements.requirements("c-1")).thenReturn(new RequirementUseCase.Requirements("c-1", List.of(one, met), Map.of()));
        f.feed.observed("odeysys", "c-1", null, "requirements");
        f.feed.observed("odeysys", "c-1", null, "requirements");
        assertThat(lines()).singleElement().extracting(ChatMessage::text).asString().contains("passes now").contains("call9");
    }

    @Test
    void watchingQueuesOneBatchPerChatWhileItsClaudeIsOnAndAQuietReplyPostsNothing() {
        f.chatStore.putSettings(new ChatSettings(CYCLE, 100, 30, true));
        watches.callCompleted("odeysys", "c0", "GET /a", 200);
        assertThat(f.chatStore.openTasks(CYCLE)).as("no Claude on: nothing queues").isEmpty();

        f.live.chatBeat("odeysys", "c-1", "chat-a", "laptop", "C:/work", "live", true, false);
        watches.callCompleted("odeysys", "c1", "GET /a", 200);
        watches.callCompleted("odeysys", "c2", "GET /b", 200);
        List<ChatMessage> tasks = f.chatStore.openTasks(CYCLE);
        assertThat(tasks).singleElement().satisfies(t -> {
            assertThat(t.origin()).isEqualTo(ChatService.WATCH);
            assertThat(t.extra().path("calls").asInt()).isEqualTo(2);
            assertThat(t.extra().path("since").asText()).isEqualTo("c1");
        });

        ChatMessage task = tasks.get(0);
        assertThat(f.chat.take(Actor.CLAUDE, task.id(), "chat-a", "c-1").isOk()).isTrue();
        watches.callCompleted("odeysys", "c3", "GET /c", 200);
        assertThat(f.chatStore.openTasks(CYCLE)).as("a taken batch is closed; the next call starts the next one").hasSize(2);

        var quiet = f.chat.reply(Actor.CLAUDE, task.id(), new Reply("nothing", List.of(), List.of(),
                com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.objectNode().put("quiet", true), null));
        assertThat(quiet.isOk()).as(quiet.message()).isTrue();
        assertThat(f.chat.page(CYCLE, null, 100).messages()).noneMatch(m -> m.author() == ChatMessage.Author.CLAUDE);
        assertThat(f.chat.message(task.id()).orElseThrow().state()).isEqualTo(ChatMessage.State.ANSWERED);
    }

    @Test
    void theProjectChatAsksACyclesClaudeAndTheExchangeShowsInBoth() {
        var asked = f.chat.post(Actor.USER, new ChatKey("odeysys", ""), new Post("did the retry run?", null, List.of(), null, false, "bridge:c-1", List.of()));
        assertThat(asked.isOk()).as(asked.message()).isTrue();
        assertThat(asked.value().chat()).isEqualTo(CYCLE);
        assertThat(asked.value().bridgeFrom()).isEqualTo("project");
        f.live.chatBeat("odeysys", "c-1", "chat-a", "laptop", "C:/work", "live", true, false);
        assertThat(f.chat.take(Actor.CLAUDE, asked.value().id(), "chat-a", "c-1").isOk()).isTrue();
        assertThat(f.chat.reply(Actor.CLAUDE, asked.value().id(), new Reply("Yes, twice.", List.of(), List.of(), null, null)).isOk()).isTrue();

        assertThat(f.chat.page(new ChatKey("odeysys", ""), null, 50).messages()).extracting(ChatMessage::text).contains("did the retry run?", "Yes, twice.");
        assertThat(f.chat.page(CYCLE, null, 50).messages()).extracting(ChatMessage::text).contains("did the retry run?", "Yes, twice.");
        assertThat(f.chat.post(Actor.USER, CYCLE, new Post("x", null, List.of(), null, false, "bridge:c-2", List.of())).isOk())
                .as("only the project chat bridges").isFalse();
    }
}
