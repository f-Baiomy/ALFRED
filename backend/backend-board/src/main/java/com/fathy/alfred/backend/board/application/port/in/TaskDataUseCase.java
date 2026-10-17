package com.fathy.alfred.backend.board.application.port.in;

/** Removes everything a task key holds - brief, spec files, checklist, evidence, chat, pages (a board was deleted). */
public interface TaskDataUseCase {

    void taskRemoved(String taskKey);
}
