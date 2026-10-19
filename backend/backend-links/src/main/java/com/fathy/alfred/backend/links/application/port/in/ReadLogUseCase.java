package com.fathy.alfred.backend.links.application.port.in;

import com.fathy.alfred.backend.links.domain.model.ReadEntry;

import java.util.List;

/** The owner's read log (D31): who read what through a stream, counted per day. */
public interface ReadLogUseCase {

    void record(String linkId, String family, String target, String via);

    List<ReadEntry> entries(String linkId, int days);
}
