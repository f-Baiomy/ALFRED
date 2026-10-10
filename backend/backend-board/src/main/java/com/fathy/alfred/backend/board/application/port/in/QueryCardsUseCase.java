package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.CardQuery;
import com.fathy.alfred.backend.board.domain.model.CardsPage;

/** One page of board rows plus the progress counts. */
public interface QueryCardsUseCase {

    CardsPage query(CardQuery query);
}
