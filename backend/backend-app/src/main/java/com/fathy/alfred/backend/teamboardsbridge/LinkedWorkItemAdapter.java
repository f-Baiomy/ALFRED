package com.fathy.alfred.backend.teamboardsbridge;

import com.fathy.alfred.backend.board.application.port.out.LinkedWorkItemPort;
import com.fathy.alfred.backend.teamboards.core.application.port.in.LinksUseCase;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.Optional;

/** The board slice reads the work item a board was opened from through the Team cache (specs/027 US8/US9). */
@Component
public class LinkedWorkItemAdapter implements LinkedWorkItemPort {

    private final ObjectProvider<LinksUseCase> links;

    public LinkedWorkItemAdapter(ObjectProvider<LinksUseCase> links) {
        this.links = links;
    }

    @Override
    public Optional<LinkedItem> linkedTo(String boardId) {
        LinksUseCase l = links.getIfAvailable();
        if (l == null) {
            return Optional.empty();
        }
        return l.linkOf(boardId).map(v -> new LinkedItem(v.conn(), v.extId(), v.provider(), v.snapshot(),
                v.changedSinceSetup().stream().map(c -> new FieldChange(c.field(), c.from(), c.to(), c.by(), c.at())).toList()));
    }

    @Override
    public void seen(String boardId) {
        LinksUseCase l = links.getIfAvailable();
        if (l != null) {
            l.seen(boardId);
        }
    }

    @Override
    public void boardDeleted(String boardId) {
        LinksUseCase l = links.getIfAvailable();
        if (l != null) {
            l.unlink(boardId);
        }
    }
}
