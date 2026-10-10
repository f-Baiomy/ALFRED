package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.CardDetail;

import java.util.Optional;

/** One card with its Linked list. */
public interface GetCardUseCase {

    Optional<CardDetail> get(String id);

    Optional<CardDetail> getByNumber(String project, int number);
}
