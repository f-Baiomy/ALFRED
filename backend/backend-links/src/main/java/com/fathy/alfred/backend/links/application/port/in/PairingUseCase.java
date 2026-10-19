package com.fathy.alfred.backend.links.application.port.in;

import com.fathy.alfred.backend.links.domain.model.Offer;
import com.fathy.alfred.backend.links.domain.model.Pairing;

import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Linking two Alfreds with a one-time code (D1). This side asks ({@link #start}); the other shows the code to whoever
 * has it open, and any user there accepts. The code is shown on both sides so they can be compared.
 */
public interface PairingUseCase {

    /** What the asking Alfred sends: who it is, and a nonce only it knows (the secret is handed only to its holder). */
    record OfferIn(String alfredId, String name, String version, String nonce, String address) {
    }

    record OfferAnswer(String offerId, String code, String alfredId, String name, String version) {
    }

    /** The answer to a waiting asker: still WAITING, or ACCEPTED with the secret (once), or REJECTED / EXPIRED. */
    record OfferResult(String state, String secret, String alfredId, String name, String version) {
    }

    // ---------------------------------------------------------------------------------------------- the asking side

    Pairing start(String address, String name);

    List<Pairing> pairings();

    void cancel(String pairingId);

    void dismiss(String pairingId);

    // ---------------------------------------------------------------------------------------------- the asked side

    OfferAnswer offer(OfferIn in, String seenFrom);

    List<Offer> offers();

    LinksUseCase.LinkInfo accept(String offerId, String name);

    void reject(String offerId);

    /** Completes when the offer is answered, or with WAITING after a while so the asker asks again. */
    CompletableFuture<OfferResult> await(String offerId, String nonce);
}
