package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.board.domain.model.Resolution;

/**
 * Claude proposes a step only the user takes (Verified, Done, closing); the user accepts - the step is then taken as
 * the user's - or dismisses it. A new proposal replaces the card's open one.
 */
public interface ProposeUseCase {

    int MAX_EVIDENCE = 8 * 1024;

    CardChange propose(Actor actor, String cardId, CardStatus status, Resolution resolution, String reason, String evidence);

    CardChange acceptProposal(Actor actor, String cardId);

    CardChange dismissProposal(Actor actor, String cardId);
}
