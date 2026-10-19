package com.fathy.alfred.backend.links.application.port.out;

import com.fathy.alfred.backend.links.application.port.in.LinksUseCase;
import com.fathy.alfred.backend.links.application.port.in.PairingUseCase;

/** Plain HTTP to another Alfred before a link exists (R4): its hello, and the pairing offer. */
public interface PeerHttpPort {

    /** GET /links/hello; throws UNSUPPORTED (404 - an Alfred without streams) or OFFLINE. */
    LinksUseCase.Hello hello(String address);

    PairingUseCase.OfferAnswer offer(String address, PairingUseCase.OfferIn in);

    /** Waits (about a minute) for the offer to be answered. */
    PairingUseCase.OfferResult await(String address, String offerId, String nonce);
}
