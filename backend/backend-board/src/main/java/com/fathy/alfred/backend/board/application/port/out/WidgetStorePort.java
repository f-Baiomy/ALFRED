package com.fathy.alfred.backend.board.application.port.out;

import com.fathy.alfred.backend.board.domain.model.Widget;

import java.util.List;
import java.util.Optional;

/** A project's widgets (specs/017 R34). */
public interface WidgetStorePort {

    /** By name, without their source. */
    List<Widget> widgets(String project);

    Optional<Widget> widget(String project, String name);

    void putWidget(Widget widget);

    boolean deleteWidget(String project, String name);
}
