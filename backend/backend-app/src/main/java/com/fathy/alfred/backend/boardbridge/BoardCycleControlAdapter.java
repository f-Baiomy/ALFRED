package com.fathy.alfred.backend.boardbridge;

import com.fathy.alfred.backend.board.application.port.out.CycleControlPort;
import com.fathy.alfred.backend.sessioncycles.application.port.in.CreateSessionCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.CycleNotesUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.GetSessionCycleUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.ListSessionCyclesUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.PauseRecordingUseCase;
import com.fathy.alfred.backend.sessioncycles.application.port.in.StartRecordingUseCase;
import com.fathy.alfred.backend.sessioncycles.domain.model.NewSessionCycle;
import com.fathy.alfred.backend.sessioncycles.domain.model.SessionCycleStatus;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Optional;

/** A board's recordings (specs/027 research R3): made, started and paused through the session-cycles slice. */
@Component
public class BoardCycleControlAdapter implements CycleControlPort {

    private final CreateSessionCycleUseCase create;
    private final StartRecordingUseCase start;
    private final PauseRecordingUseCase pause;
    private final GetSessionCycleUseCase get;
    private final ListSessionCyclesUseCase list;
    private CycleNotesUseCase notes;

    /** A re-test's description (specs/033); without it, a recording starts without one. */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    void setNotes(CycleNotesUseCase notes) {
        this.notes = notes;
    }

    @Override
    public boolean describe(String cycleId, String description) {
        if (notes == null || description == null) return false;
        String text = description.length() > CycleNotesUseCase.DESCRIPTION_MAX ? description.substring(0, CycleNotesUseCase.DESCRIPTION_MAX) : description;
        return notes.updateNotes(cycleId, text, null).isPresent();
    }

    public BoardCycleControlAdapter(CreateSessionCycleUseCase create, StartRecordingUseCase start, PauseRecordingUseCase pause,
                                    GetSessionCycleUseCase get, ListSessionCyclesUseCase list) {
        this.create = create;
        this.start = start;
        this.pause = pause;
        this.get = get;
        this.list = list;
    }

    @Override
    public Optional<String> create(String name) {
        return Optional.of(create.create(new NewSessionCycle(name, null)).id());
    }

    @Override
    public boolean start(String cycleId) {
        return start.startRecording(cycleId).isPresent();
    }

    @Override
    public boolean pause(String cycleId) {
        return pause.pauseRecording(cycleId).isPresent();
    }

    @Override
    public boolean recording(String cycleId) {
        return get.getById(cycleId).map(c -> c.status() == SessionCycleStatus.RECORDING).orElse(false);
    }

    @Override
    public List<String> recordingCycles() {
        return list.listAll().stream().filter(c -> c.status() == SessionCycleStatus.RECORDING).map(c -> c.id()).toList();
    }

    @Override
    public boolean exists(String cycleId) {
        return cycleId != null && !cycleId.isBlank() && get.getById(cycleId).isPresent();
    }
}
