package com.fathy.alfred.backend.board.domain.model;

/** A mention as indexed in board.db: who wrote it ({@code owner}), the card it belongs to (null for a brief or
 *  checklist evidence) and the reference itself. {@code direct} marks a Linked-list entry added without text. */
public record Mention(MentionOwner owner, String ownerId, String cardId, MentionRef ref) {
}
