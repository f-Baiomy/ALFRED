package com.fathy.alfred.backend.boardbridge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fathy.alfred.backend.board.application.port.in.BoardOfUseCase;
import com.fathy.alfred.backend.board.domain.model.BoardIds;
import com.fathy.alfred.backend.sessions.domain.model.WriteDecision;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.Function;

/**
 * Which board(s) a /board write is about (specs/031), for the board lock: from the path first (a board, a cycle, a card, a
 * chat, a chat message, a snippet, a file, an ask, a run), then from the request's own fields (boardId, cycleId, cardId,
 * project + cardNumber, project for a project-wide chat or card). A write naming no board - teams, widgets, storage, an
 * undo token - is no single board's and the lock lets it by. Plumbing of the sessions themselves (keys, holders, runner
 * heartbeats and claims) is never locked: a held board must still be askable, and its holder's runner must still beat.
 */
final class BoardWriteTargets {

    record Target(Set<String> boards, WriteDecision.Kind kind) {

        static final Target NONE = new Target(Set.of(), WriteDecision.Kind.EDIT);
    }

    /** Paths the lock never looks at (prefixes after /board/). */
    static final List<String> EXEMPT = List.of("helpers", "browsers", "me", "holders", "sessions", "helper-commands", "users", "audit",
            "live-runner", "live-work", "agent-status", "storage", "import", "teams", "widgets", "chats/terminal/delivered",
            "skill-runs/claim", "access");

    private final BoardOfUseCase boards;

    BoardWriteTargets(BoardOfUseCase boards) {
        this.boards = boards;
    }

    /**
     * @param path   the request path, starting with /board/
     * @param params the query parameters (first value each)
     * @param body   the JSON body, or null when there is none or it is not JSON
     */
    Target of(String method, String path, Map<String, String> params, JsonNode body) {
        if (path == null || !path.startsWith("/board/")) {
            return Target.NONE;
        }
        String rest = path.substring("/board/".length());
        for (String e : EXEMPT) {
            String p = e.endsWith("/") ? e.substring(0, e.length() - 1) : e;
            if (rest.equals(p) || rest.startsWith(p + "/")) {
                return Target.NONE;
            }
        }
        // a run's report is its runner's plumbing; stopping a run is a board write
        if ("PUT".equals(method) && rest.startsWith("skill-runs/")) {
            return Target.NONE;
        }
        String[] seg = rest.split("/");
        Set<String> out = new LinkedHashSet<>();
        WriteDecision.Kind kind = WriteDecision.Kind.EDIT;
        Function<String, String> field = name -> text(params.get(name), body == null ? null : body.path(name));
        String project = field.apply("project");
        switch (seg[0]) {
            case "boards", "cycles" -> {
                if (seg.length >= 2) {
                    out.add(seg[1]);
                    if (seg.length >= 4 && "boards".equals(seg[2])) {
                        out.add(seg[3]);
                    }
                }
            }
            case "cards" -> {
                if (seg.length >= 2 && !List.of("bulk", "quick", "cycles").contains(seg[1])) {
                    boards.boardOfCard(seg[1]).ifPresent(out::add);
                    if (seg.length >= 3 && "comments".equals(seg[2])) {
                        kind = WriteDecision.Kind.COMMENT;
                    }
                }
            }
            case "chats" -> {
                if (seg.length >= 3 && "messages".equals(seg[1])) {
                    longOf(seg[2]).flatMap(boards::boardOfChatMessage).ifPresent(out::add);
                    if (seg.length >= 4 && "react".equals(seg[3])) {
                        kind = WriteDecision.Kind.COMMENT;
                    }
                } else if (seg.length >= 3 && "records".equals(seg[1])) {
                    longOf(seg[2]).flatMap(boards::boardOfChatRecord).ifPresent(out::add);
                } else if (seg.length >= 2 && !List.of("terminal", "undo", "watches").contains(seg[1]) && project != null) {
                    out.add(boards.boardOfChat(project, seg[1]));
                    if (seg.length >= 3 && "messages".equals(seg[2])) {
                        kind = WriteDecision.Kind.MESSAGE;
                    }
                }
            }
            case "snippets" -> {
                if (seg.length >= 2) {
                    boards.boardOfSnippet(seg[1]).ifPresent(out::add);
                }
            }
            case "files" -> {
                if (seg.length >= 2) {
                    boards.boardOfFile(seg[1]).ifPresent(out::add);
                }
            }
            case "asks" -> {
                if (seg.length >= 2) {
                    boards.boardOfAsk(seg[1]).ifPresent(out::add);
                }
            }
            case "skill-runs" -> {
                if (seg.length >= 2 && !"stop-all".equals(seg[1])) {
                    boards.boardOfRun(seg[1]).ifPresent(out::add);
                }
            }
            default -> {
                // pages, images, retest, ... : by their fields below
            }
        }
        // the request's own fields name more boards (a card moved to another board, a new card, a run, an ask)
        String boardId = field.apply("boardId");
        if (boardId != null) {
            out.add(boardId);
        }
        String cycleId = field.apply("cycleId");
        if (cycleId != null) {
            out.add(cycleId);
        }
        String cardId = field.apply("cardId");
        if (cardId != null) {
            boards.boardOfCard(cardId).ifPresent(out::add);
        }
        Integer number = intOf(field.apply("cardNumber"));
        if (number != null && project != null) {
            boards.boardOfCardNumber(project, number).ifPresent(out::add);
        }
        if (out.isEmpty() && project != null && List.of("cards", "skill-runs", "asks", "pages").contains(seg[0])) {
            out.add(BoardIds.defaultOf(project));
        }
        return new Target(Set.copyOf(out), kind);
    }

    private static String text(String param, JsonNode node) {
        if (param != null && !param.isBlank()) {
            return param.strip();
        }
        if (node != null && (node.isTextual() || node.isNumber())) {
            String v = node.asText().strip();
            return v.isEmpty() ? null : v;
        }
        return null;
    }

    private static Optional<Long> longOf(String s) {
        try {
            return Optional.of(Long.parseLong(s));
        } catch (NumberFormatException e) {
            return Optional.empty();
        }
    }

    private static Integer intOf(String s) {
        if (s == null) {
            return null;
        }
        try {
            return Integer.parseInt(s);
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
