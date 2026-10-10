package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.MentionRef;

/** Adds or removes a link on a card's Linked list without writing it in text. */
public interface LinkCardUseCase {

    CardChange link(Actor actor, String id, MentionRef ref);

    CardChange unlink(Actor actor, String id, String type, String ref);
}
