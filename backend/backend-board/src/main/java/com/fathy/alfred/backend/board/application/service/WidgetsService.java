package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.in.SnippetsUseCase.Result;
import com.fathy.alfred.backend.board.application.port.in.WidgetsUseCase;
import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.application.port.out.WidgetStorePort;
import com.fathy.alfred.backend.board.domain.model.Actor;
import com.fathy.alfred.backend.board.domain.model.CardChange.Outcome;
import com.fathy.alfred.backend.board.domain.model.Widget;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.List;
import java.util.Locale;
import java.util.Optional;

/**
 * A project's widgets (specs/017 R34). Every change signals /ws/board {@code widgets} (texts using one re-read it).
 */
@Service
public class WidgetsService implements WidgetsUseCase {

    private final WidgetStorePort store;
    private final BoardNotificationPort notifications;
    private final Clock clock;

    @Autowired
    public WidgetsService(WidgetStorePort store, BoardNotificationPort notifications) {
        this(store, notifications, Clock.systemUTC());
    }

    WidgetsService(WidgetStorePort store, BoardNotificationPort notifications, Clock clock) {
        this.store = store;
        this.notifications = notifications;
        this.clock = clock;
    }

    @Override
    public Result<List<Widget>> widgets(String project) {
        return Result.ok(store.widgets(project == null ? "" : project.strip()));
    }

    @Override
    public Optional<Widget> widget(String project, String name) {
        return name == null || !name.matches(Widget.NAME) ? Optional.empty() : store.widget(project == null ? "" : project.strip(), name);
    }

    @Override
    public Result<Widget> put(Actor actor, String project, String name, String kind, String info, String source) {
        String p = project == null ? "" : project.strip();
        if (name == null || !name.matches(Widget.NAME)) {
            return Result.refused(Outcome.INVALID, "A widget's name is a word of letters, digits, - and _ (at most 60)");
        }
        Widget.Kind k;
        try {
            k = Widget.Kind.valueOf((kind == null || kind.isBlank() ? "HTML" : kind.strip()).toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            return Result.refused(Outcome.INVALID, "A widget is HTML, MERMAID, PYTHON or BLOCK");
        }
        String src = source == null ? "" : source;
        if (src.isBlank()) {
            return Result.refused(Outcome.INVALID, "A widget needs its source");
        }
        if (src.getBytes(StandardCharsets.UTF_8).length > Widget.MAX_SOURCE) {
            return Result.refused(Outcome.INVALID, "A widget's source can be at most 256 KB");
        }
        String i = info == null ? "" : info.strip();
        if (i.length() > 500) {
            return Result.refused(Outcome.INVALID, "A widget's settings line can be at most 500 characters");
        }
        Optional<Widget> existing = store.widget(p, name);
        if (existing.isPresent() && actor == Actor.CLAUDE && existing.get().author() != Actor.CLAUDE) {
            return Result.refused(Outcome.REFUSED_FOR_CLAUDE, "Claude changes only the widgets it created - this one is the user's");
        }
        if (existing.isEmpty() && store.widgets(p).size() >= Widget.MAX_PER_PROJECT) {
            return Result.refused(Outcome.INVALID, "At most " + Widget.MAX_PER_PROJECT + " widgets in one project");
        }
        Widget w = new Widget(p, name, k, i, src, existing.map(Widget::author).orElse(actor), clock.instant(), actor);
        store.putWidget(w);
        notifications.changed(p, null, null, "widgets");
        return Result.ok(w);
    }

    @Override
    public Result<Void> delete(Actor actor, String project, String name) {
        String p = project == null ? "" : project.strip();
        Optional<Widget> w = widget(p, name);
        if (w.isEmpty()) {
            return Result.refused(Outcome.NOT_FOUND, "No such widget");
        }
        if (actor == Actor.CLAUDE && w.get().author() != Actor.CLAUDE) {
            return Result.refused(Outcome.REFUSED_FOR_CLAUDE, "Claude deletes only the widgets it created");
        }
        store.deleteWidget(p, name);
        notifications.changed(p, null, null, "widgets");
        return Result.ok(null);
    }
}
