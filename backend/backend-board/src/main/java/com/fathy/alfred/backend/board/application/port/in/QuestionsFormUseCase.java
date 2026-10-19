package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.application.port.in.SnippetsUseCase.Result;

import java.util.List;

/**
 * The questions form (specs/037, docs/board.md "Questions form"): a board's open questions as one self-contained HTML
 * file someone outside Alfred answers offline - all of them, one card's or the selected cards'. Alfred keeps what it put
 * in the file, so the answers file that comes back is read by question and option ids.
 */
public interface QuestionsFormUseCase {

    /** Over this the result carries a warning: big for mail, better sent through Teams or SharePoint. */
    long WARN_BYTES = 10L * 1024 * 1024;

    /**
     * {@code cards}: card numbers, empty for every card with open questions. {@code lang}: ar, en or auto (the language
     * most questions are written in). {@code zip}: the same one html inside a .zip, for mail that blocks html files.
     */
    record Request(String boardId, List<Integer> cards, String lang, String title, boolean zip) {

        public Request {
            cards = cards == null ? List.of() : List.copyOf(cards);
        }
    }

    /** The file and what went into it; {@code leftOut} says what is not in it and why (a card with no open question, a live snippet). */
    record Built(String formId, String fileName, String contentType, byte[] bytes, long htmlBytes, int questions, List<Integer> cards,
                 List<String> leftOut, String warning) {

        public Built {
            cards = List.copyOf(cards);
            leftOut = List.copyOf(leftOut);
        }
    }

    Result<Built> build(Request request);
}
