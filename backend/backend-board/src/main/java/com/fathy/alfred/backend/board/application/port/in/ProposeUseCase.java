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

    /** Claude proposes merging this card into card #{@code intoNumber} of the same project (a duplicate). */
    CardChange proposeMerge(Actor actor, String cardId, int intoNumber, String reason, String evidence);

    /** Claude proposes reopening a Done / Verified / closed card (a regression). */
    CardChange proposeReopen(Actor actor, String cardId, String reason, String evidence);

    CardChange acceptProposal(Actor actor, String cardId);

    /**
     * The user merges this card into card #{@code intoNumber} of the same project (triage: a duplicate, or one card of a
     * root-cause group): its history and links move there and it closes as a duplicate. Claude only proposes a merge.
     */
    CardChange merge(Actor actor, String cardId, int intoNumber, String reason);

    CardChange dismissProposal(Actor actor, String cardId);
}
