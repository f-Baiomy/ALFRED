package com.fathy.alfred.backend.board.application.port.in;

import com.fathy.alfred.backend.board.application.port.in.SnippetsUseCase.Result;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.Widget;

import java.util.List;
import java.util.Optional;

/**
 * A project's widgets (specs/017 R34). Saving a name that exists replaces it; Claude may create widgets and replace or
 * delete the ones it created, never the user's.
 */
public interface WidgetsUseCase {

    Result<List<Widget>> widgets(String project);

    Optional<Widget> widget(String project, String name);

    Result<Widget> put(Actor actor, String project, String name, String kind, String info, String source);

    Result<Void> delete(Actor actor, String project, String name);
}
