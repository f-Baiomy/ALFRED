package com.fathy.alfred.backend.board.application.port.out;

import com.fathy.alfred.backend.board.domain.model.QuestionForm;

import java.util.Optional;

/** The questions forms Alfred made (specs/037), so an answers file can be checked against the form it came from. */
public interface QuestionFormStorePort {

    void saveForm(QuestionForm form);

    Optional<QuestionForm> findForm(String id);
}
