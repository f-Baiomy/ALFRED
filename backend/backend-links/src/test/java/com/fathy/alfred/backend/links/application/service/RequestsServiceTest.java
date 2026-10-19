package com.fathy.alfred.backend.links.application.service;

import com.fathy.alfred.backend.links.adapter.out.sqlite.SqliteLinksRepository;
import com.fathy.alfred.backend.links.application.port.in.LinksProblem;
import com.fathy.alfred.backend.links.application.port.out.LinksNotificationPort;
import com.fathy.alfred.backend.links.application.port.out.PeerTransportPort;
import com.fathy.alfred.backend.links.application.port.out.RequestApplyPort;
import com.fathy.alfred.backend.links.domain.model.Link;
import com.fathy.alfred.backend.links.domain.model.LinkRequest;
import com.fathy.alfred.backend.links.domain.model.RequestState;
import com.fathy.alfred.backend.links.domain.model.Stream;
import com.fathy.alfred.backend.links.domain.model.StreamKind;
import com.fathy.alfred.backend.links.domain.model.StreamMode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.ObjectProvider;

import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * The owner's side of requests (D10-D14): only what a COMMENT stream covers is taken, the first answer wins (a
 * compare-and-set on WAITING), an accepted request is applied and can be undone, a retry never makes a second request,
 * and every answer is queued for the reader as a durable event.
 */
class RequestsServiceTest {

    @TempDir
    Path dir;

    private final MutableClock clock = new MutableClock(Instant.parse("2026-10-19T08:00:00Z"));
    private final PeerTransportPort transport = mock(PeerTransportPort.class);
    private final RelayService relay = mock(RelayService.class);
    private SqliteLinksRepository store;
    private RequestsService requests;
    private final Link reader = new Link("L1", "stg-83", "STG 83", "peer-1", "Alfred b", "http://10.0.0.83:3000", false, "s", Instant.EPOCH,
            null, "1.53.0", null);

    /** The fake board: what it allows, what it made, what it took back. */
    private final List<String> applied = new ArrayList<>();
    private final List<String> undone = new ArrayList<>();
    private boolean allows = true;
    private RuntimeException applyFails;
    private RuntimeException undoFails;

    @BeforeEach
    @SuppressWarnings("unchecked")
    void open() {
        store = new SqliteLinksRepository(dir.resolve("links.db").toString());
        store.init();
        store.saveLink(reader);
        RequestApplyPort board = new RequestApplyPort() {
            @Override
            public Optional<String> allows(Stream stream, LinkRequest request) {
                return allows ? Optional.of("#7 Refund total") : Optional.empty();
            }

            @Override
            public String apply(Stream stream, LinkRequest request, String authorName) {
                if (applyFails != null) {
                    throw applyFails;
                }
                applied.add(authorName + ": " + request.text());
                return "comment-" + applied.size();
            }

            @Override
            public void undo(LinkRequest request) {
                if (undoFails != null) {
                    throw undoFails;
                }
                undone.add(request.resultRef());
            }
        };
        ObjectProvider<RequestApplyPort> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(board);
        requests = new RequestsService(store, relay, transport, mock(LinksNotificationPort.class), provider, clock);
    }

    private Stream stream(StreamMode mode, boolean autoAccept, boolean passOn) {
        Stream s = new Stream(UUID.randomUUID().toString(), true, "L1", StreamKind.BOARD, "b1", "dashboard", "odeysys", mode, autoAccept, passOn,
                StreamMode.VIEW, false, null, null, clock.instant(), null);
        store.saveStream(s);
        return s;
    }

    private static String wire(String id, Stream s, boolean claude) {
        return Json.write(new RequestsService.Wire(id, s.id(), com.fathy.alfred.backend.links.domain.model.RequestKind.CARD_COMMENT, "card-7",
                "#7", "total is off by the fee", null, claude, null));
    }

    private LinkRequest receive(String id, Stream s) {
        return requests.receive(reader, List.of(), wire(id, s, false));
    }

    @Test
    void aRequestWaitsWithTheTargetsOwnLabelAndARetryNeverMakesASecond() {
        Stream s = stream(StreamMode.COMMENT, false, false);
        LinkRequest r = requests.receive(reader, List.of(), wire("r1", s, true));
        assertThat(r.state()).isEqualTo(RequestState.WAITING);
        assertThat(r.author()).isEqualTo("STG 83 (Claude)");
        assertThat(r.targetLabel()).isEqualTo("#7 Refund total");
        assertThat(requests.waiting()).isEqualTo(1);

        LinkRequest again = receive("r1", s);
        assertThat(again.id()).isEqualTo("r1");
        assertThat(store.requests(true, null, null, 10)).hasSize(1);
    }

    @Test
    void theFirstAnswerWinsAndTheReaderHearsIt() {
        Stream s = stream(StreamMode.COMMENT, false, false);
        receive("r1", s);
        LinkRequest accepted = requests.accept("r1");
        assertThat(accepted.state()).isEqualTo(RequestState.ACCEPTED);
        assertThat(accepted.resultRef()).isEqualTo("comment-1");
        assertThat(applied).containsExactly("STG 83: total is off by the fee");

        assertThatThrownBy(() -> requests.reject("r1", "no"))
                .isInstanceOfSatisfying(LinksProblem.class, p -> assertThat(p.code()).isEqualTo("ANSWERED"));
        assertThatThrownBy(() -> requests.accept("r1")).isInstanceOf(LinksProblem.class);
        assertThat(applied).hasSize(1);
        // the sender taking it back after the answer gets the answer instead
        assertThat(requests.withdrawn(reader, "r1").state()).isEqualTo(RequestState.ACCEPTED);

        assertThat(store.outbox("L1")).anySatisfy(e -> {
            assertThat(e.kind()).isEqualTo("request-state");
            assertThat(e.data()).contains("ACCEPTED").contains("comment-1");
        });
        verify(transport, atLeastOnce()).flush("L1");
    }

    @Test
    void aWithdrawnRequestCanNoLongerBeAccepted() {
        Stream s = stream(StreamMode.COMMENT, false, false);
        receive("r1", s);
        assertThat(requests.withdrawn(reader, "r1").state()).isEqualTo(RequestState.WITHDRAWN);
        assertThatThrownBy(() -> requests.accept("r1")).isInstanceOf(LinksProblem.class);
        assertThat(applied).isEmpty();
    }

    @Test
    void undoTakesBackWhatWasMadeAndAFailedUndoLeavesItAccepted() {
        Stream s = stream(StreamMode.COMMENT, false, false);
        receive("r1", s);
        requests.accept("r1");

        undoFails = new IllegalStateException("the card is closed");
        assertThatThrownBy(() -> requests.undo("r1"))
                .isInstanceOfSatisfying(LinksProblem.class, p -> assertThat(p.code()).isEqualTo("UNDO_FAILED"));
        assertThat(store.request("r1").orElseThrow().state()).isEqualTo(RequestState.ACCEPTED);

        undoFails = null;
        assertThat(requests.undo("r1").state()).isEqualTo(RequestState.UNDONE);
        assertThat(undone).containsExactly("comment-1");
        assertThatThrownBy(() -> requests.undo("r1"))
                .isInstanceOfSatisfying(LinksProblem.class, p -> assertThat(p.code()).isEqualTo("NOT_ACCEPTED"));
    }

    @Test
    void aRequestThatCannotBeAppliedIsFailedWithTheReason() {
        Stream s = stream(StreamMode.COMMENT, false, false);
        receive("r1", s);
        applyFails = new IllegalStateException("the card was deleted");
        LinkRequest r = requests.accept("r1");
        assertThat(r.state()).isEqualTo(RequestState.FAILED);
        assertThat(r.note()).contains("the card was deleted");
    }

    @Test
    void anAutoAcceptingStreamTakesItAtOnce() {
        Stream s = stream(StreamMode.COMMENT, true, false);
        LinkRequest r = receive("r1", s);
        assertThat(r.state()).isEqualTo(RequestState.ACCEPTED);
        assertThat(r.auto()).isTrue();
        assertThat(applied).hasSize(1);
        assertThat(requests.waiting()).isZero();
    }

    @Test
    void onlyWhatACommentStreamCoversIsTaken() {
        Stream view = stream(StreamMode.VIEW, false, false);
        assertThatThrownBy(() -> receive("r1", view))
                .isInstanceOfSatisfying(LinksProblem.class, p -> assertThat(p.code()).isEqualTo("VIEW_ONLY"));

        Stream comment = stream(StreamMode.COMMENT, false, false);
        assertThatThrownBy(() -> requests.receive(reader, List.of("a", "b"), wire("r2", comment, false)))
                .isInstanceOfSatisfying(LinksProblem.class, p -> assertThat(p.code()).isEqualTo("NOT_PASSED_ON"));

        allows = false;
        assertThatThrownBy(() -> receive("r3", comment))
                .isInstanceOfSatisfying(LinksProblem.class, p -> assertThat(p.code()).isEqualTo("NOT_ALLOWED"));

        allows = true;
        store.saveStream(comment.ended(clock.instant()));
        assertThatThrownBy(() -> receive("r4", comment))
                .isInstanceOfSatisfying(LinksProblem.class, p -> assertThat(p.code()).isEqualTo("NOT_STREAMED"));

        Link other = new Link("L2", "pc-9", "PC 9", "peer-9", "x", "http://x", false, "s", Instant.EPOCH, null, "1", null);
        store.saveLink(other);
        Stream mine = stream(StreamMode.COMMENT, false, false);
        assertThatThrownBy(() -> requests.receive(other, List.of(), wire("r5", mine, false)))
                .isInstanceOfSatisfying(LinksProblem.class, p -> assertThat(p.code()).isEqualTo("NOT_STREAMED"));
        assertThat(store.requests(true, null, null, 10)).isEmpty();
    }

    @Test
    void theReaderKeepsTheOwnersAnswer() {
        LinkRequest mine = new LinkRequest("r9", "S1", "L1", false, com.fathy.alfred.backend.links.domain.model.RequestKind.CALL_NOTE, "k",
                "GET /x", "why?", null, "PC-1", RequestState.WAITING, null, null, clock.instant(), null, false);
        store.saveRequest(mine);
        requests.stateChanged(reader, Json.write(new RequestsService.StateEvent("r9", RequestState.REJECTED, "not this call", null,
                clock.instant(), false, "GET /x")));
        LinkRequest after = store.request("r9").orElseThrow();
        assertThat(after.state()).isEqualTo(RequestState.REJECTED);
        assertThat(after.note()).isEqualTo("not this call");
    }
}
