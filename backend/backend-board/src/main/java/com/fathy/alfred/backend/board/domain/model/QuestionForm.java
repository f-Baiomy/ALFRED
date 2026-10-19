package com.fathy.alfred.backend.board.domain.model;

import java.time.Instant;
import java.util.List;

/**
 * A questions form Alfred made (specs/037): the board's open questions as they were when the file was built, under the
 * {@code id} the file carries. An answers file names questions and options by the ids given here ({@code q1}, {@code o1},
 * {@code f1}), so its meaning never depends on the file's text; {@code hash} tells a question changed since.
 */
public record QuestionForm(String id, String boardId, String project, Instant createdAt, String lang, List<Item> questions) {

    public QuestionForm {
        questions = questions == null ? List.of() : List.copyOf(questions);
    }

    /** One option: the id in the form and the label the board's question has. */
    public record Option(String id, String label) {
    }

    /** A follow-up asked when {@code optionId} is picked; its own header in the same question comment. */
    public record FollowUp(String id, String header, String optionId, String hash, List<Option> options) {

        public FollowUp {
            options = options == null ? List.of() : List.copyOf(options);
        }
    }

    /** One question: where it is on the board (card, question comment, header) and its options and follow-ups. */
    public record Item(String id, String cardId, int cardNumber, long entryId, String header, String hash, boolean multiSelect,
                       List<Option> options, List<FollowUp> followUps) {

        public Item {
            options = options == null ? List.of() : List.copyOf(options);
            followUps = followUps == null ? List.of() : List.copyOf(followUps);
        }

        public String key() {
            return cardNumber + "/" + entryId + "/" + header;
        }
    }

    public java.util.Optional<Item> item(String questionId) {
        return questions.stream().filter(q -> q.id().equals(questionId)).findFirst();
    }
}
