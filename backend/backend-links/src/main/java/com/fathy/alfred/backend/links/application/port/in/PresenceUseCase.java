package com.fathy.alfred.backend.links.application.port.in;

import com.fathy.alfred.backend.links.domain.model.Presence;

import java.util.List;

/** Who is looking (D29): this Alfred's pages tell the owner what they have open; the owner shows it. */
public interface PresenceUseCase {

    /** Reader side: a page ({@code pageId}) opened ({@code on}) or closed a streamed thing reached through {@code slug}. */
    void viewing(String pageId, String slug, String target, boolean on);

    /** Reader side: a page went away; everything it had open is closed. */
    void pageGone(String pageId);

    /** Owner side: the linked Alfreds that have this Alfred's things open now. */
    List<Presence> presence();
}
