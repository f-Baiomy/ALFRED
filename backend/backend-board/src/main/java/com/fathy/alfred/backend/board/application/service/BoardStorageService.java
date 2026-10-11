package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.BoardStorageUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.domain.ClaudeRules;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.BoardStorage;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import org.springframework.stereotype.Service;

/** board.db's size and Compact: deleting a cycle or cards frees pages SQLite only gives back to the disk on VACUUM. */
@Service
public class BoardStorageService implements BoardStorageUseCase {

    private final BoardStorePort store;

    public BoardStorageService(BoardStorePort store) {
        this.store = store;
    }

    @Override
    public BoardStorage storage() {
        return store.storage();
    }

    @Override
    public Compacted compact(Actor actor) {
        if (actor == Actor.CLAUDE) {
            return new Compacted(CardChange.Outcome.REFUSED_FOR_CLAUDE, null, null, ClaudeRules.USER_ONLY);
        }
        BoardStorage before = store.storage();
        store.compact();
        return new Compacted(CardChange.Outcome.OK, before, store.storage(), null);
    }
}
