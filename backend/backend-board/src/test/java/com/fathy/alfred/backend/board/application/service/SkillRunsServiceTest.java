package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.LiveWorkUseCase;
import com.fathy.alfred.backend.board.application.port.in.SkillRunsUseCase;
import com.fathy.alfred.backend.board.application.port.in.SkillRunsUseCase.Report;
import com.fathy.alfred.backend.board.application.port.in.SkillRunsUseCase.Request;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.application.port.out.SkillRunStorePort;
import com.fathy.alfred.backend.board.domain.model.AgentStatus;
import com.fathy.alfred.backend.board.domain.model.SkillRun;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/** ▶ on the board: one chat per cycle, the queue for that chat, its runner's claim, the chat taking and ending a run, cancel, a lost chat, "usually takes". */
public class SkillRunsServiceTest {

    private Instant now = Instant.parse("2026-10-14T10:00:00Z");
    private final Clock clock = new Clock() {
        @Override
        public ZoneOffset getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(java.time.ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    };
    private final List<SkillRun> signalled = new ArrayList<>();
    private final BoardNotificationPort notifications = new BoardNotificationPort() {
        @Override
        public void changed(String project, String cycleId, String cardId, String what) {
        }

        @Override
        public void agentStatus(AgentStatus status) {
        }

        @Override
        public void skillRun(SkillRun run) {
            signalled.add(run);
        }
    };
    private final LiveWorkService live = new LiveWorkService(notifications, clock);
    private final MemoryStore store = new MemoryStore();
    private final SkillRunsService service = new SkillRunsService(store, live, notifications, clock);

    private SkillRunsUseCase.Outcome run(Integer card, String command) {
        return service.request(new Request("odeysys", "cy1", card, command, command + "\nAlfred: http://localhost:3000", null, null, null, false));
    }

    /** The chat that runs /alfred-live (or /alfred-listen) for a cycle, as its runner's heartbeat reports it. */
    private LiveWorkUseCase.ChatBeat chat(String cycleId, String chatId, String kind) {
        return live.chatBeat("odeysys", cycleId, chatId, "laptop", "C:/work/odeysys", kind, true, false);
    }

    @Test
    void withNoChatForTheCycleTheButtonIsToldHowToStartOne() {
        SkillRunsUseCase.Outcome out = run(35, "/alfred-fix 35");

        assertThat(out.run()).isNull();
        assertThat(out.error()).isEqualTo("not-found");
        assertThat(out.message()).contains("No chat handles this cycle").contains("copy the prompt");
    }

    @Test
    void aCommandWithoutACycleIsCopyOnly() {
        chat("cy1", "chat-a", "live");

        SkillRunsUseCase.Outcome out = service.request(new Request("odeysys", null, null, "/alfred-status", null, null, null, null, false));

        assertThat(out.error()).isEqualTo("invalid");
        assertThat(out.message()).contains("copy");
    }

    @Test
    void aRequestIsQueuedForTheCyclesChatSignalledAndWakesTheRunnersWait() {
        chat("cy1", "chat-a", "live");
        AtomicInteger woken = new AtomicInteger();
        service.onQueued(woken::incrementAndGet);

        SkillRun r = run(35, "/alfred-fix 35").run();

        assertThat(r.state()).isEqualTo(SkillRun.State.QUEUED);
        assertThat(r.chatId()).isEqualTo("chat-a");
        assertThat(woken).hasValue(1);
        assertThat(signalled).extracting(SkillRun::id).containsExactly(r.id());
    }

    @Test
    void oneChatPerCycleASecondChatIsRefused() {
        chat("cy1", "chat-a", "live");

        LiveWorkUseCase.ChatBeat second = chat("cy1", "chat-b", "listen");

        assertThat(second.conflict()).isTrue();
        assertThat(second.chat().chatId()).isEqualTo("chat-a");
        assertThat(live.cycleChat("cy1")).get().extracting(LiveWorkUseCase.CycleChat::chatId).isEqualTo("chat-a");
        assertThat(chat("cy1", "chat-a", "listen").chat().kinds()).containsExactlyInAnyOrder("live", "listen");
    }

    @Test
    void oneRunPerCardAtATime() {
        chat("cy1", "chat-a", "live");
        run(35, "/alfred-fix 35");

        SkillRunsUseCase.Outcome again = run(35, "/alfred-sync 35");

        assertThat(again.error()).isEqualTo("conflict");
        assertThat(again.message()).contains("Already waiting for the chat: /alfred-fix 35");
        assertThat(run(36, "/alfred-fix 36").run()).isNotNull();
    }

    @Test
    void onlyTheCyclesChatClaimsItsRunsOldestFirstUpToItsLimit() {
        chat("cy1", "chat-a", "live");
        chat("cy2", "chat-b", "live");
        SkillRun a = run(1, "/alfred-fix 1").run();
        now = now.plusSeconds(1);
        SkillRun b = run(2, "/alfred-fix 2").run();
        now = now.plusSeconds(1);
        service.request(new Request("odeysys", "cy2", 3, "/alfred-fix 3", null, null, null, null, false));

        List<SkillRun> taken = service.claim("chat-a", "laptop", 5);

        assertThat(taken).extracting(SkillRun::id).containsExactly(a.id(), b.id());
        assertThat(taken).allSatisfy(r -> {
            assertThat(r.state()).isEqualTo(SkillRun.State.SENT);
            assertThat(r.takenBy()).isEqualTo("laptop");
        });
        assertThat(service.claim("chat-b", "pc", 5)).extracting(SkillRun::cardNumber).containsExactly(3);
        assertThat(service.claim("chat-a", "laptop", 5)).isEmpty();
    }

    @Test
    void theChatTakesTheRunAndEndsIt() {
        chat("cy1", "chat-a", "live");
        SkillRun r = run(35, "/alfred-fix 35").run();
        service.claim("chat-a", "laptop", 1);

        SkillRun taken = service.report(r.id(), new Report(SkillRun.State.RUNNING, List.of("reading #35"), null, null, null, null)).orElseThrow();
        assertThat(taken.state()).isEqualTo(SkillRun.State.RUNNING);
        assertThat(taken.takenAt()).isEqualTo(now);

        now = now.plusSeconds(30);
        SkillRun ended = service.report(r.id(), new Report(SkillRun.State.DONE, null, "→ plan posted", null, null, "#35 [4]")).orElseThrow();
        assertThat(ended.state()).isEqualTo(SkillRun.State.DONE);
        assertThat(ended.endedAt()).isEqualTo(now);
        assertThat(ended.result()).isEqualTo("#35 [4]");
        assertThat(ended.steps()).containsExactly("reading #35");
    }

    @Test
    void cancellingWorksUntilTheChatTakesTheRunThenTheRunIsTheChats() {
        chat("cy1", "chat-a", "live");
        SkillRun queued = run(35, "/alfred-fix 35").run();
        SkillRun sent = run(36, "/alfred-fix 36").run();
        service.stop(queued.id());
        service.claim("chat-a", "laptop", 5);
        SkillRun running = run(37, "/alfred-fix 37").run();
        service.claim("chat-a", "laptop", 5);
        service.report(running.id(), new Report(SkillRun.State.RUNNING, null, null, null, null, null));

        assertThat(service.stop(sent.id())).get().extracting(SkillRun::state).isEqualTo(SkillRun.State.CANCELLED);
        assertThat(service.stop(running.id())).get().extracting(SkillRun::state).isEqualTo(SkillRun.State.RUNNING);
        // the chat taking a cancelled run learns it was cancelled
        assertThat(service.report(sent.id(), new Report(SkillRun.State.RUNNING, null, null, null, null, null)))
                .get().extracting(SkillRun::state).isEqualTo(SkillRun.State.CANCELLED);
    }

    @Test
    void aStoppedQueuedRunNeverReachesTheChat() {
        chat("cy1", "chat-a", "live");
        SkillRun r = run(35, "/alfred-fix 35").run();

        assertThat(service.stop(r.id())).get().extracting(SkillRun::state).isEqualTo(SkillRun.State.CANCELLED);
        assertThat(service.claim("chat-a", "laptop", 5)).isEmpty();
    }

    @Test
    void aRunWaitingWhenTheChatStopsIsTakenByTheNextChatForTheCycle() {
        chat("cy1", "chat-a", "live");
        SkillRun r = run(35, "/alfred-fix 35").run();
        live.chatBeat("odeysys", "cy1", "chat-a", "laptop", null, "live", true, true);

        chat("cy1", "chat-b", "live");

        assertThat(service.claim("chat-b", "laptop", 5)).extracting(SkillRun::id).containsExactly(r.id());
    }

    @Test
    void aRunWhoseChatIsGoneReadsAsLost() {
        chat("cy1", "chat-a", "live");
        SkillRun r = run(35, "/alfred-fix 35").run();
        service.claim("chat-a", "laptop", 1);

        now = now.plus(Duration.ofMinutes(6));

        SkillRun shown = service.list("odeysys", 35, 10).runs().get(0);
        assertThat(shown.id()).isEqualTo(r.id());
        assertThat(shown.state()).isEqualTo(SkillRun.State.FAILED);
        assertThat(shown.failure()).isEqualTo("lost");
    }

    @Test
    void usuallyTakesIsTheMedianOfEachSkillsFinishedRuns() {
        for (int seconds : new int[]{30, 40, 90}) {
            chat("cy1", "chat-a", "live");
            SkillRun r = run(7, "/alfred-verify 7").run();
            service.claim("chat-a", "laptop", 1);
            service.report(r.id(), new Report(SkillRun.State.RUNNING, null, null, null, null, null));
            now = now.plusSeconds(seconds);
            service.report(r.id(), new Report(SkillRun.State.DONE, null, "→ verified", null, null, "#7"));
            now = now.plusSeconds(1);
        }

        assertThat(service.list("odeysys", null, 10).usualMs()).containsEntry("/alfred-verify", 40_000L);
    }

    @Test
    void cancelAllCancelsWhatTheChatHasNotTaken() {
        chat("cy1", "chat-a", "live");
        SkillRun one = run(1, "/alfred-fix 1").run();
        run(2, "/alfred-fix 2");
        run(3, "/alfred-fix 3");
        service.claim("chat-a", "laptop", 2);
        service.report(one.id(), new Report(SkillRun.State.RUNNING, null, null, null, null, null));

        assertThat(service.stopAll("odeysys")).isEqualTo(2);
        assertThat(service.list("odeysys", null, 10).runs()).extracting(r -> r.state().name())
                .containsExactlyInAnyOrder("RUNNING", "CANCELLED", "CANCELLED");
    }

    @Test
    void aCommandMustBeASlashCommand() {
        chat("cy1", "chat-a", "live");
        assertThat(run(1, "rm -rf /").error()).isEqualTo("invalid");
    }

    /** The store as the service sees it. */
    public static final class MemoryStore implements SkillRunStorePort {
        final Map<String, SkillRun> runs = new LinkedHashMap<>();

        @Override
        public void saveRun(SkillRun run) {
            runs.put(run.id(), run);
        }

        @Override
        public Optional<SkillRun> findRun(String id) {
            return Optional.ofNullable(runs.get(id));
        }

        @Override
        public List<SkillRun> runs(String project, Integer cardNumber, int limit) {
            return runs.values().stream().filter(r -> project == null || project.equals(r.project()))
                    .filter(r -> cardNumber == null || cardNumber.equals(r.cardNumber()))
                    .sorted(Comparator.comparing(SkillRun::createdAt).reversed()).limit(limit).toList();
        }

        @Override
        public List<SkillRun> activeRuns(String project) {
            return runs.values().stream().filter(SkillRun::active).filter(r -> project == null || project.equals(r.project()))
                    .sorted(Comparator.comparing(SkillRun::createdAt)).toList();
        }

        @Override
        public void pruneRuns(String project, int keep) {
        }
    }
}
