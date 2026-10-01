package com.fathy.alfred.backend.relive.application.port.in;

import java.util.List;

/** Parameters of {@link DeleteRunHistoryUseCase#delete}. An empty {@code runIds} list means the
 *  cycle's entire run history. */
public record DeleteRunHistoryCommand(List<String> runIds, boolean deleteCalls) {

    public static DeleteRunHistoryCommand all(boolean deleteCalls) {
        return new DeleteRunHistoryCommand(List.of(), deleteCalls);
    }
}
