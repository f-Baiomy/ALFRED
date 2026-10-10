package com.fathy.alfred.backend.board.application.port.in;

import java.io.BufferedReader;
import java.io.IOException;
import java.util.List;

/** Reads an alfred-board/1 export into a project; clashing numbers get new ones and card mentions follow. */
public interface ImportBoardUseCase {

    long MAX_BYTES = 200L * 1024 * 1024;

    record Renumbered(int from, int to) {
    }

    record ImportResult(int cards, List<Renumbered> renumbered) {
    }

    ImportResult importBoard(String project, BufferedReader lines) throws IOException;
}
