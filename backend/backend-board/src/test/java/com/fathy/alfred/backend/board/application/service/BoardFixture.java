package com.fathy.alfred.backend.board.application.service;

import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fathy.alfred.backend.board.adapter.out.sqlite.TestRepositories;
import com.fathy.alfred.backend.board.application.port.in.CreateCardUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.application.port.out.CallSignaturePort;
import com.fathy.alfred.backend.board.application.port.out.MentionedCallsChangedPort;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardDetail;
import com.fathy.alfred.backend.board.domain.model.CardKind;
import com.fathy.alfred.backend.board.domain.model.MentionRef;

import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The board's services over a real board.db in a temp folder, with the other ports faked. The store is used for real
 * because the services' behaviour is mostly what it remembers (numbers, history, mentions, signatures); the ports to
 * other slices - signals, call signatures, kept calls - are recorded fakes.
 */
final class BoardFixture implements AutoCloseable {

    final BoardStorePort store;
    final List<String> signals = new ArrayList<>();
    final Map<String, String> signatures = new HashMap<>();
    int mentionedCallsChanged;
    final MutableClock clock = new MutableClock(Instant.parse("2026-10-10T09:00:00Z"));
    final AgentStatusService agent;
    final BoardService board;
    final CycleBriefService briefs;
    final ImportBoardService imports;
    final BoardChangeFeed feed = new BoardChangeFeed();
    final List<com.fathy.alfred.backend.board.domain.model.CycleCall> cycleCalls = new ArrayList<>();
    final List<com.fathy.alfred.backend.board.domain.model.CycleCall> liveCalls = new ArrayList<>();
    final BoardInsightsService insights;
    /** Facts per call id (live) or "cycle/callId" (captured), for the re-test. */
    final Map<String, com.fathy.alfred.backend.board.domain.model.CallFacts> facts = new HashMap<>();
    /** Request and response bodies per call id (live) or "cycle/callId", for the re-test's step and empty-answer checks. */
    final Map<String, com.fathy.alfred.backend.board.application.port.out.CallFactsPort.CallBodies> bodies = new HashMap<>();
    final RetestService retest;
    final com.fathy.alfred.backend.board.application.port.out.SnippetStorePort snippetStore;
    final SnippetsService snippets;
    final com.fathy.alfred.backend.board.application.port.out.ChatStorePort chatStore;
    final BoardFilesService files;
    final LiveWorkService live;
    final ChatRecordService chatRecords;
    final ChatService chat;
    ChatProposalService proposals;
    final com.fathy.alfred.backend.board.application.port.out.CallFactsPort factsPort;
    final BoardNotificationPort notifications;
    final WidgetsService widgets;
    final com.fathy.alfred.backend.board.application.port.out.BriefCommentStorePort briefCommentStore;
    final BriefCommentService briefComments;
    final com.fathy.alfred.backend.board.application.port.out.BoardModelStorePort boardModel;
    final BoardsService boards;
    final BoardModelMigration migration;
    /** Fake session cycles for the boards: those that exist, and those recording. */
    final java.util.Set<String> cyclesHere = new java.util.LinkedHashSet<>();
    final java.util.Set<String> recordingHere = new java.util.LinkedHashSet<>();
    private final AutoCloseable closer;

    BoardFixture(Path dir) {
        TestRepositories.Opened opened = TestRepositories.open(JsonMapper.builder().findAndAddModules().build(), dir.resolve("board.db"));
        this.store = opened.store();
        this.closer = opened.closer();
        notifications = new BoardNotificationPort() {
            @Override
            public void changed(String project, String cycleId, String cardId, String what) {
                signals.add(what + ":" + project + ":" + cycleId);
            }

            @Override
            public void agentStatus(com.fathy.alfred.backend.board.domain.model.AgentStatus status) {
                signals.add("agent:" + status.state());
            }

            @Override
            public void chatChanged(String project, String scope, Long id) {
                signals.add("chat:" + project + ":" + scope + ":" + id);
            }
        };
        CallSignaturePort signaturePort = (direction, callId, cycleId) -> Optional.ofNullable(signatures.get(callId));
        MentionedCallsChangedPort mentioned = () -> mentionedCallsChanged++;
        agent = new AgentStatusService(notifications, clock);
        board = new BoardService(store, notifications, signaturePort, mentioned, agent, feed, clock);
        briefs = new CycleBriefService(store, notifications, mentioned, feed, clock);
        imports = new ImportBoardService(store, notifications, mentioned, feed,
                (com.fathy.alfred.backend.board.application.port.out.BoardImageStorePort) store);
        insights = new BoardInsightsService(store, signaturePort, (cycleId, limit) -> List.copyOf(cycleCalls), feed,
                limit -> List.copyOf(liveCalls));
        factsPort = new com.fathy.alfred.backend.board.application.port.out.CallFactsPort() {
            @Override
            public Optional<com.fathy.alfred.backend.board.domain.model.CallFacts> facts(String callId, String cycleId, Set<String> paths) {
                return Optional.ofNullable(facts.get(cycleId == null ? callId : cycleId + "/" + callId));
            }

            @Override
            public Optional<com.fathy.alfred.backend.board.domain.model.CycleCall> call(String ref) {
                return Optional.empty();
            }

            @Override
            public Optional<CallBodies> bodies(String callId, String cycleId) {
                return Optional.ofNullable(bodies.get(cycleId == null ? callId : cycleId + "/" + callId));
            }
        };
        snippetStore = TestRepositories.snippets(store);
        snippets = new SnippetsService(snippetStore, store, notifications, JsonMapper.builder().findAndAddModules().build(), clock);
        briefs.setSnippets(snippetStore);
        chatStore = TestRepositories.chats(store, JsonMapper.builder().findAndAddModules().build());
        briefs.setChats(chatStore);
        briefCommentStore = TestRepositories.briefComments(store);
        briefComments = new BriefCommentService(briefCommentStore, briefs, notifications, feed, clock);
        imports.setBriefComments(briefCommentStore);
        files = new BoardFilesService((com.fathy.alfred.backend.board.application.port.out.BoardFileStorePort) snippetStore, store, notifications, clock);
        widgets = new WidgetsService((com.fathy.alfred.backend.board.application.port.out.WidgetStorePort) snippetStore, notifications, clock);
        imports.setVisualStores(snippetStore, (com.fathy.alfred.backend.board.application.port.out.BoardFileStorePort) snippetStore,
                (com.fathy.alfred.backend.board.application.port.out.WidgetStorePort) snippetStore);
        retest = new RetestService(store, factsPort, limit -> List.copyOf(liveCalls), (cycleId, limit) -> List.copyOf(cycleCalls), notifications,
                feed, clock);
        live = new LiveWorkService(notifications, clock);
        live.setChatStore(chatStore);
        com.fasterxml.jackson.databind.ObjectMapper json = JsonMapper.builder().findAndAddModules().build();
        chatRecords = new ChatRecordService(store, board, board, briefs, board, board, json, clock);
        chat = new ChatService(chatStore, store, notifications, mentioned, live, chatRecords, feed, json, clock);
        insights.setChats(chatStore);
        com.fathy.alfred.backend.board.application.port.out.CycleNamesPort names = id -> java.util.Optional.ofNullable(cycleNames.get(id));
        chat.setCycleNames(names);
        imports.setChats(chatStore);
        proposals = new ChatProposalService(chatStore, store, board, board, board, board, briefs, briefs, notifications, feed, clock);
        imports.setCycleNames(names);
        boardModel = TestRepositories.boardModel(store, json);
        board.setBoardModel(boardModel);
        briefs.setBoardModel(boardModel);
        imports.setBoards(boardModel);
        com.fathy.alfred.backend.board.application.port.out.CycleControlPort control = new com.fathy.alfred.backend.board.application.port.out.CycleControlPort() {
            private int n;

            @Override
            public Optional<String> create(String name) {
                String id = "cyc-new-" + (++n);
                cyclesHere.add(id);
                cycleNames.put(id, name);
                recordingHere.add(id);
                return Optional.of(id);
            }

            @Override
            public boolean start(String cycleId) {
                recordingHere.add(cycleId);
                return cyclesHere.contains(cycleId);
            }

            @Override
            public boolean pause(String cycleId) {
                recordingHere.remove(cycleId);
                return cyclesHere.contains(cycleId);
            }

            @Override
            public boolean recording(String cycleId) {
                return recordingHere.contains(cycleId);
            }

            @Override
            public List<String> recordingCycles() {
                return List.copyOf(recordingHere);
            }

            @Override
            public boolean exists(String cycleId) {
                return cyclesHere.contains(cycleId);
            }

            @Override
            public boolean describe(String cycleId, String description) {
                cycleDescriptions.put(cycleId, description);
                return true;
            }
        };
        boards = new BoardsService(boardModel, store, chatStore, board, briefs, notifications, provider(control),
                provider(new com.fathy.alfred.backend.board.application.port.out.LinkedWorkItemPort() { }), clock);
        migration = new BoardModelMigration(boardModel, names, provider(control), clock);
        record = new RecordForBoardService(boardModel, boards, provider(control), provider(names), clock);
        record.setCards(store);
    }

    final java.util.Map<String, String> cycleDescriptions = new java.util.HashMap<>();

    RecordForBoardService record;

    static <T> org.springframework.beans.factory.ObjectProvider<T> provider(T bean) {
        org.springframework.beans.factory.support.StaticListableBeanFactory f = new org.springframework.beans.factory.support.StaticListableBeanFactory();
        f.addBean("bean", bean);
        @SuppressWarnings("unchecked")
        org.springframework.beans.factory.ObjectProvider<T> p = (org.springframework.beans.factory.ObjectProvider<T>) f.getBeanProvider(bean.getClass().getInterfaces()[0]);
        return p;
    }

    /** The session cycles that exist here, by id (chat export names them, import checks them). */
    final java.util.Map<String, String> cycleNames = new java.util.HashMap<>();

    CardDetail add(Actor actor, String project, CardKind kind, String title, String description) {
        CardChange change = board.create(actor, new CreateCardUseCase.NewCard(project, kind, title, description, Set.of(), null, null, List.of()));
        assertThat(change.outcome()).as(change.message()).isEqualTo(CardChange.Outcome.OK);
        return change.card();
    }

    CardChange create(Actor actor, String project, String title, List<MentionRef> links) {
        return board.create(actor, new CreateCardUseCase.NewCard(project, CardKind.BUG, title, "", Set.of(), null, null, links));
    }

    @Override
    public void close() throws Exception {
        closer.close();
    }

    static final class MutableClock extends Clock {
        private Instant now;

        MutableClock(Instant now) {
            this.now = now;
        }

        void advanceSeconds(long seconds) {
            now = now.plusSeconds(seconds);
        }

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
    }
}
