package com.fathy.alfred.backend.boardbridge;

import com.fathy.alfred.backend.board.application.port.in.RecordForBoardUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.out.RecordingGuardPort;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.Optional;

/**
 * Session Cycles asks before a cycle records (specs/027 FR-008): the board slice knows which project each cycle records
 * for, through the boards it is on. A cycle on no board is never in anyone's way.
 */
@Component
public class BoardRecordingGuardAdapter implements RecordingGuardPort {

    private final ObjectProvider<RecordForBoardUseCase> boards;

    public BoardRecordingGuardAdapter(ObjectProvider<RecordForBoardUseCase> boards) {
        this.boards = boards;
    }

    @Override
    public Optional<String> runningConflict(String cycleId) {
        RecordForBoardUseCase b = boards.getIfAvailable();
        return b == null ? Optional.empty() : b.recordingConflict(cycleId);
    }
}
