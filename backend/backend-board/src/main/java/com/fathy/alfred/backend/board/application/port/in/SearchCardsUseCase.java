package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.CardQuery;
import com.fathy.alfred.backend.board.domain.model.CardSearchHit;
import com.fathy.alfred.backend.board.domain.model.MentionRef;

import java.util.List;

/** Cards across every board, each with its latest comment; and cards that look like a finding about to be reported. */
public interface SearchCardsUseCase {

    int MAX_SIMILAR = 50;

    record SearchPage(List<CardSearchHit> cards, int total) {
    }

    SearchPage search(CardQuery query);

    /** A similar card: why it matched (same signature, title words) and the card. */
    record Similar(String why, CardSearchHit card) {
    }

    /**
     * Open or closed cards with the signature of {@code call} (when given) or with words of {@code title} - Claude reads
     * these before adding a card. {@code project} null searches every board.
     */
    List<Similar> similar(String project, String title, MentionRef call, int limit);
}
