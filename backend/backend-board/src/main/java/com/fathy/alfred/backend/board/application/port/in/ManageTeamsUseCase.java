package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.domain.model.Team;

import java.util.List;

/** Settings → Teams: the list cards are assigned from. */
public interface ManageTeamsUseCase {

    List<Team> teams();

    /** Adds a team (no id) or changes one. Fails with IllegalArgumentException on a blank or duplicate name. */
    Team save(TeamEdit edit);

    /** Deletes the team; it is taken off every card. False when there is no such team. */
    boolean delete(String id);

    /** Puts the teams in this order; ids not given keep their place after them. */
    List<Team> reorder(List<String> ids);

    record TeamEdit(String id, String name, String color, String icon, String owns, List<String> hints) {
    }
}
