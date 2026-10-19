package com.fathy.alfred.backend.links.application.service;

import com.fathy.alfred.backend.links.adapter.out.sqlite.SqliteLinksRepository;
import com.fathy.alfred.backend.links.application.port.in.LinksProblem;
import com.fathy.alfred.backend.links.application.port.in.LinksUseCase;
import com.fathy.alfred.backend.links.application.port.in.PairingUseCase.OfferAnswer;
import com.fathy.alfred.backend.links.application.port.in.PairingUseCase.OfferIn;
import com.fathy.alfred.backend.links.application.port.in.PairingUseCase.OfferResult;
import com.fathy.alfred.backend.links.application.port.out.DiscoveryPort;
import com.fathy.alfred.backend.links.application.port.out.LinksNotificationPort;
import com.fathy.alfred.backend.links.application.port.out.PeerHttpPort;
import com.fathy.alfred.backend.links.application.port.out.PeerTransportPort;
import com.fathy.alfred.backend.links.domain.model.Link;
import com.fathy.alfred.backend.links.domain.model.LinkState;
import com.fathy.alfred.backend.links.domain.model.Pairing;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Linking with a one-time code (D1): the secret goes out once, only to the Alfred that made the offer (it alone knows
 * the nonce); an offer lives ten minutes; a crowd of offers is refused; nobody links with itself.
 */
class PairingServiceTest {

    @TempDir
    Path dir;

    private final MutableClock clock = new MutableClock(Instant.parse("2026-10-19T08:00:00Z"));
    private final PeerHttpPort http = mock(PeerHttpPort.class);
    private final PeerTransportPort transport = mock(PeerTransportPort.class);
    private final LinksNotificationPort notifications = mock(LinksNotificationPort.class);
    private SqliteLinksRepository store;
    private LinksService links;
    private PairingService pairing;

    private static final String NONCE = "0123456789abcdef0123456789abcdef";

    @BeforeEach
    void open() {
        store = new SqliteLinksRepository(dir.resolve("links.db").toString());
        store.init();
        when(transport.state(anyString())).thenAnswer(i -> LinkState.offline(i.getArgument(0), "not connected in this test", Instant.EPOCH));
        links = new LinksService(store, transport, notifications, mock(DiscoveryPort.class), clock, "1.53.0", "STG 83");
        pairing = new PairingService(store, links, http, transport, notifications, clock);
    }

    @AfterEach
    void close() {
        pairing.stop();
    }

    private OfferAnswer offerFrom(String alfredId, String nonce) {
        return pairing.offer(new OfferIn(alfredId, "PC-1", "1.53.0", nonce, "http://10.0.0.5:3000"), "10.0.0.5");
    }

    @Test
    void theSecretGoesOutOnceAndOnlyToTheNonceThatAsked() throws Exception {
        OfferAnswer a = offerFrom("pc-1", NONCE);
        assertThat(a.code()).matches("\\d{3} \\d{3}");
        assertThat(pairing.offers()).singleElement().satisfies(o -> assertThat(o.code()).isEqualTo(a.code()));

        CompletableFuture<OfferResult> waiting = pairing.await(a.offerId(), NONCE);
        assertThat(waiting).isNotDone();
        assertThatThrownBy(() -> pairing.await(a.offerId(), "ffffffffffffffffffffffffffffffff"))
                .isInstanceOfSatisfying(LinksProblem.class, p -> assertThat(p.code()).isEqualTo("NOT_YOURS"));

        LinksUseCase.LinkInfo info = pairing.accept(a.offerId(), "PC-1 host");
        OfferResult first = waiting.get(5, TimeUnit.SECONDS);
        assertThat(first.state()).isEqualTo("ACCEPTED");
        assertThat(first.secret()).hasSize(64);
        Link stored = store.link(info.id()).orElseThrow();
        assertThat(stored.secret()).isEqualTo(first.secret());
        assertThat(stored.slug()).isEqualTo("pc-1-host");

        // collected: asking again never hands the secret a second time
        OfferResult again = pairing.await(a.offerId(), NONCE).get(5, TimeUnit.SECONDS);
        assertThat(again.secret()).isNull();
        assertThat(again.state()).isEqualTo("EXPIRED");
        assertThatThrownBy(() -> pairing.accept(a.offerId(), null))
                .isInstanceOfSatisfying(LinksProblem.class, p -> assertThat(p.code()).isEqualTo("ANSWERED"));
    }

    @Test
    void aRefusedOfferTellsTheAskerAndCannotBeAcceptedAfter() throws Exception {
        OfferAnswer a = offerFrom("pc-1", NONCE);
        CompletableFuture<OfferResult> waiting = pairing.await(a.offerId(), NONCE);
        pairing.reject(a.offerId());
        assertThat(waiting.get(5, TimeUnit.SECONDS).state()).isEqualTo("REJECTED");
        assertThatThrownBy(() -> pairing.accept(a.offerId(), null)).isInstanceOf(LinksProblem.class);
        assertThat(store.links(true)).isEmpty();
    }

    @Test
    void anOfferExpiresAfterTenMinutes() throws Exception {
        OfferAnswer a = offerFrom("pc-1", NONCE);
        CompletableFuture<OfferResult> waiting = pairing.await(a.offerId(), NONCE);
        clock.advance(PairingService.OFFER_LIFE.plus(Duration.ofSeconds(1)));
        assertThat(pairing.offers()).isEmpty();
        assertThat(waiting.get(5, TimeUnit.SECONDS).state()).isEqualTo("EXPIRED");
        assertThatThrownBy(() -> pairing.accept(a.offerId(), null))
                .isInstanceOfSatisfying(LinksProblem.class, p -> assertThat(p.code()).isEqualTo("ANSWERED"));
    }

    @Test
    void refusesItselfAShortNonceAndACrowd() {
        String self = links.self().alfredId();
        assertThatThrownBy(() -> offerFrom(self, NONCE)).isInstanceOf(LinksProblem.class);
        assertThatThrownBy(() -> offerFrom("pc-1", "short")).isInstanceOf(LinksProblem.class);
        // a second offer from the same Alfred replaces its first
        offerFrom("pc-1", NONCE);
        offerFrom("pc-1", NONCE);
        assertThat(pairing.offers()).hasSize(1);
        for (int i = 2; i <= PairingService.MAX_WAITING_OFFERS; i++) {
            offerFrom("pc-" + i, NONCE);
        }
        assertThatThrownBy(() -> offerFrom("pc-99", NONCE))
                .isInstanceOfSatisfying(LinksProblem.class, p -> assertThat(p.status()).isEqualTo(429));
    }

    @Test
    void theAskingSideLinksWithTheSecretItCollected() {
        when(http.hello("http://10.0.0.83:3000")).thenReturn(new LinksUseCase.Hello("stg-id", "Alfred STG", "1.53.0", 0, false));
        when(http.offer(eq("http://10.0.0.83:3000"), any())).thenReturn(new OfferAnswer("o1", "123 456", "stg-id", "Alfred STG", "1.53.0"));
        when(http.await(eq("http://10.0.0.83:3000"), eq("o1"), anyString()))
                .thenReturn(new OfferResult("ACCEPTED", "the-secret", "stg-id", "Alfred STG", "1.53.0"));

        Pairing p = pairing.start("10.0.0.83:3000/", "STG 83");
        assertThat(p.code()).isEqualTo("123 456");
        assertThat(p.state()).isEqualTo(Pairing.State.WAITING);

        verify(transport, timeout(5000)).connect(any(Link.class));
        Link link = store.linkByPeer("stg-id").orElseThrow();
        assertThat(link.secret()).isEqualTo("the-secret");
        assertThat(link.slug()).isEqualTo("stg-83");
        assertThat(pairing.pairings()).singleElement().satisfies(x -> assertThat(x.state()).isEqualTo(Pairing.State.LINKED));

        // the same Alfred again: refused, it is already linked
        assertThatThrownBy(() -> pairing.start("10.0.0.83:3000", null))
                .isInstanceOfSatisfying(LinksProblem.class, x -> assertThat(x.code()).isEqualTo("ALREADY_LINKED"));
    }

    @Test
    void anAddressIsNormalized() {
        assertThat(PairingService.normalize(" 192.168.1.83:3000/ ")).isEqualTo("http://192.168.1.83:3000");
        assertThat(PairingService.normalize("https://alfred.lan")).isEqualTo("https://alfred.lan");
        assertThatThrownBy(() -> PairingService.normalize("  ")).isInstanceOf(LinksProblem.class);
    }
}
