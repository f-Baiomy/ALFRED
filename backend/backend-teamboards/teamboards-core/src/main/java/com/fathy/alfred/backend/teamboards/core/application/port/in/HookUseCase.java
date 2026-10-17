package com.fathy.alfred.backend.teamboards.core.application.port.in;

import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.HookInfo;

/**
 * The tracker's service hook (specs/028 US5, FR-081..083): Azure pings {@code POST /teamboards/hooks/azure} with a
 * secret; only the item ids in the body are read. With a live token the items are read and routed to the boards whose
 * tree holds them or whose rules match; without one the ids wait until a token is entered.
 */
public interface HookUseCase {

    int PER_MINUTE = 60;

    enum Ping { ACCEPTED, BAD_SECRET, TOO_MANY, NOT_SUPPORTED }

    /** {@code secret}: the password of the basic auth Azure sends. */
    Ping ping(String kind, String secret, String body);

    HookInfo info(String conn);

    /** A new secret, returned once; only its hash is kept. */
    String rotateSecret(String conn);

    HookInfo putPublicAddress(String conn, String address);

    /** A token was entered: the waiting ids are read and routed now. */
    void drain(String conn);
}
