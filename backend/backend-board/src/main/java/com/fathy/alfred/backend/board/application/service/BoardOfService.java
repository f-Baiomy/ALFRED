package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.BoardOfUseCase;
import com.fathy.alfred.backend.board.application.port.out.AskStorePort;
import com.fathy.alfred.backend.board.application.port.out.BoardFileStorePort;
import com.fathy.alfred.backend.board.application.port.out.BoardStorePort;
import com.fathy.alfred.backend.board.application.port.out.ChatStorePort;
import com.fathy.alfred.backend.board.application.port.out.SkillRunStorePort;
import com.fathy.alfred.backend.board.application.port.out.SnippetStorePort;
import com.fathy.alfred.backend.board.domain.model.BoardIds;
import com.fathy.alfred.backend.board.domain.model.Card;
import com.fathy.alfred.backend.board.domain.model.ChatKey;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.util.Optional;

/** See {@link BoardOfUseCase}. Optional stores (snippets, files, asks, chats) answer empty when this build has none. */
@Service
public class BoardOfService implements BoardOfUseCase {

    private final BoardStorePort cards;
    private final ObjectProvider<ChatStorePort> chats;
    private final ObjectProvider<SnippetStorePort> snippets;
    private final ObjectProvider<BoardFileStorePort> files;
    private final ObjectProvider<AskStorePort> asks;
    private final ObjectProvider<SkillRunStorePort> skillRuns;

    public BoardOfService(BoardStorePort cards, ObjectProvider<ChatStorePort> chats, ObjectProvider<SnippetStorePort> snippets,
                          ObjectProvider<BoardFileStorePort> files, ObjectProvider<AskStorePort> asks, ObjectProvider<SkillRunStorePort> skillRuns) {
        this.cards = cards;
        this.skillRuns = skillRuns;
        this.chats = chats;
        this.snippets = snippets;
        this.files = files;
        this.asks = asks;
    }

    @Override
    public Optional<String> boardOfCard(String cardId) {
        return cardId == null || cardId.isBlank() ? Optional.empty() : cards.find(cardId).map(Card::boardId);
    }

    @Override
    public Optional<String> boardOfCardNumber(String project, int number) {
        return project == null || project.isBlank() ? Optional.empty() : cards.findByNumber(project, number).map(Card::boardId);
    }

    @Override
    public Optional<String> boardOfChatMessage(long messageId) {
        ChatStorePort store = chats.getIfAvailable();
        return store == null ? Optional.empty() : store.find(messageId).map(m -> boardOf(m.chat()));
    }

    @Override
    public Optional<String> boardOfSnippet(String snippetId) {
        SnippetStorePort store = snippets.getIfAvailable();
        return store == null ? Optional.empty() : store.find(snippetId).map(s -> owner(s.project(), s.cardId(), s.cycleId()));
    }

    @Override
    public Optional<String> boardOfFile(String fileId) {
        BoardFileStorePort store = files.getIfAvailable();
        return store == null ? Optional.empty() : store.findFile(fileId).map(f -> owner(f.project(), f.cardId(), f.cycleId()));
    }

    @Override
    public Optional<String> boardOfAsk(String askId) {
        AskStorePort store = asks.getIfAvailable();
        return store == null ? Optional.empty() : store.findAsk(askId).map(a -> owner(a.project(), a.cardId(), a.cycleId()));
    }

    @Override
    public Optional<String> boardOfChatRecord(long recordId) {
        ChatStorePort store = chats.getIfAvailable();
        return store == null ? Optional.empty() : store.findRecord(recordId).flatMap(r -> boardOfChatMessage(r.messageId()));
    }

    @Override
    public Optional<String> boardOfRun(String runId) {
        SkillRunStorePort store = skillRuns.getIfAvailable();
        return store == null || runId == null || runId.isBlank() ? Optional.empty() : store.findRun(runId).map(r -> owner(r.project(), null, r.cycleId()));
    }

    @Override
    public String boardOfChat(String project, String scope) {
        return boardOf(ChatKey.of(project, scope));
    }

    private static String boardOf(ChatKey key) {
        return key.isProject() ? BoardIds.defaultOf(key.project()) : key.cycleId();
    }

    /** A card's board when it names one, else its cycle's board, else the project's default board. */
    private String owner(String project, String cardId, String cycleId) {
        return boardOfCard(cardId).orElseGet(() -> cycleId != null && !cycleId.isBlank() ? cycleId : BoardIds.defaultOf(project));
    }
}
