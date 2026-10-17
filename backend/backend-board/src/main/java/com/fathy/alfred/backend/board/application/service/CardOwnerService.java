package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.CardOwnerUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.CardChange;
import com.fathy.alfred.backend.board.domain.model.CardStatus;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Pattern;

/** Card owners (specs/028 FR-089), kept beside the card so the card's own record and its exports stay as they were. */
@Service
public class CardOwnerService implements CardOwnerUseCase {

    /** {@code <conn>/<personId>|Display Name}: the person's ref, then the name a pill shows. */
    static final Pattern OWNER = Pattern.compile("[A-Za-z0-9_.:-]{1,100}/[^|\\s]{1,200}\\|[^\\r\\n\\]]{1,200}");

    private final BoardStorePort store;
    private final BoardNotificationPort notifications;

    public CardOwnerService(BoardStorePort store, BoardNotificationPort notifications, BoardChangeFeed feed) {
        this.store = store;
        this.notifications = feed.feeding(notifications);
    }

    @Override
    public Optional<String> owner(String cardId) {
        return store.owner(cardId);
    }

    @Override
    public Map<String, String> owners(List<String> cardIds) {
        return cardIds == null || cardIds.isEmpty() ? Map.of() : store.owners(cardIds);
    }

    @Override
    public CardChange setOwner(Actor actor, String cardId, String owner) {
        Optional<Card> found = store.find(cardId);
        if (found.isEmpty()) {
            return CardChange.notFound();
        }
        Card card = found.get();
        String value = owner == null || owner.isBlank() ? null : owner.strip();
        if (value != null && (value.length() > MAX_OWNER || !OWNER.matcher(value).matches())) {
            return CardChange.refused(CardChange.Outcome.INVALID, "An owner is <connection>/<person id>|<name>");
        }
        if (actor == Actor.CLAUDE && !(card.author() == Actor.CLAUDE && card.status() == CardStatus.INBOX)) {
            return CardChange.refused(CardChange.Outcome.REFUSED_FOR_CLAUDE, "Claude sets the owner only on its own Inbox cards");
        }
        store.putOwner(cardId, value);
        notifications.changed(card.project(), card.cycleId(), card.id(), "card");
        return CardChange.ok(null);
    }

    @Override
    public PersonCards cardsOf(String personRef, int limit) {
        int max = Math.max(1, Math.min(limit <= 0 ? 50 : limit, 500));
        List<Card> owned = cards(store.cardsOwnedBy(personRef), max);
        List<Card> mentioning = cards(store.cardsMentioning("person", personRef), max);
        return new PersonCards(owned, mentioning);
    }

    private List<Card> cards(List<String> ids, int max) {
        List<Card> out = new ArrayList<>();
        for (String id : ids) {
            store.find(id).ifPresent(out::add);
        }
        out.sort(Comparator.comparing(Card::updatedAt, Comparator.nullsLast(Comparator.reverseOrder())));
        return out.size() > max ? out.subList(0, max) : out;
    }
}
