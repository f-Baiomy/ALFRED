package com.fathy.alfred.backend.teamboardsbridge;

import com.fathy.alfred.backend.board.application.port.out.CardStatusChangedPort;
import com.fathy.alfred.backend.board.application.port.out.LinkedWorkItemPort;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import com.fathy.alfred.backend.teamboards.core.application.port.in.AzureWritesUseCase;
import com.fathy.alfred.backend.teamboards.core.application.port.in.BoardItemsUseCase;
import com.fathy.alfred.backend.teamboards.core.domain.model.TeamModels.Who;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.Optional;

/**
 * The board slice's view of its tracker items (specs/027 US8/US9, 028 US2/US4): a board's main item for the chip on the
 * Task tab with what changed in Azure since the copy, the board's items going with it when it is deleted, and a card's
 * status change heard by the Team slice (it prepares Tell Azure bundles - nothing is sent without the user).
 */
@Component
public class LinkedWorkItemAdapter implements LinkedWorkItemPort, CardStatusChangedPort {

    private static final Logger log = LoggerFactory.getLogger(LinkedWorkItemAdapter.class);

    private final ObjectProvider<BoardItemsUseCase> items;
    private final ObjectProvider<AzureWritesUseCase> writes;

    public LinkedWorkItemAdapter(ObjectProvider<BoardItemsUseCase> items, ObjectProvider<AzureWritesUseCase> writes) {
        this.items = items;
        this.writes = writes;
    }

    @Override
    public Optional<LinkedItem> linkedTo(String boardId) {
        BoardItemsUseCase b = items.getIfAvailable();
        if (b == null) {
            return Optional.empty();
        }
        return b.mainSummary(boardId).map(m -> new LinkedItem(m.conn(), m.item(), m.provider(), m.snapshot(),
                m.changes().stream().map(c -> new FieldChange(c.field(), c.from(), c.to(), null, null)).toList()));
    }

    /** "Saved / dismissed" on the chip: the copy takes Azure's version (028 "Keep Azure's version"). */
    @Override
    public void seen(String boardId) {
        BoardItemsUseCase b = items.getIfAvailable();
        if (b == null) {
            return;
        }
        b.mainSummary(boardId).ifPresent(m -> {
            try {
                b.keep(boardId, m.conn(), m.item());
            } catch (RuntimeException e) {
                log.info("Main of board {} not kept: {}", boardId, e.getMessage());
            }
        });
    }

    @Override
    public void boardDeleted(String boardId) {
        BoardItemsUseCase b = items.getIfAvailable();
        if (b != null) {
            b.boardDeleted(boardId);
        }
    }

    @Override
    public void statusChanged(Card card, CardStatus from, Actor actor) {
        AzureWritesUseCase w = writes.getIfAvailable();
        if (w != null) {
            w.cardStatusChanged(card.id(), card.boardId(), from == null ? null : from.name(), card.status().name(),
                    card.resolution() == null ? null : card.resolution().name(), actor == Actor.CLAUDE ? Who.CLAUDE : Who.USER);
        }
    }
}
