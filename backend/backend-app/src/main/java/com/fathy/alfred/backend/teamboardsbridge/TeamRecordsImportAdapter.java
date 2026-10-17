package com.fathy.alfred.backend.teamboardsbridge;

import com.fathy.alfred.backend.board.application.port.out.TeamRecordsImportPort;
import com.fathy.alfred.backend.teamboards.core.application.port.in.TeamTransferUseCase;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.Map;

/** A board import's tracker records (specs/028 FR-112) written by the Team slice, onto the ids the board import gave them. */
@Component
public class TeamRecordsImportAdapter implements TeamRecordsImportPort {

    private final ObjectProvider<TeamTransferUseCase> transfer;

    public TeamRecordsImportAdapter(ObjectProvider<TeamTransferUseCase> transfer) {
        this.transfer = transfer;
    }

    @Override
    public boolean imported(String kind, String boardId, String cardId, Map<String, Object> fields) {
        TeamTransferUseCase t = transfer.getIfAvailable();
        return t != null && t.importRecord(kind, boardId, cardId, fields);
    }
}
