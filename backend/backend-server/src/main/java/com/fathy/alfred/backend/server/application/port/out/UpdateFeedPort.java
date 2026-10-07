package com.fathy.alfred.backend.server.application.port.out;

import com.fathy.alfred.backend.server.domain.model.UpdateManifest;

import java.io.IOException;

/** Where releases are announced: the {@code latest.json} of ALFRED_UPDATE_URL (GitHub Releases by default). */
public interface UpdateFeedPort {

    /** @throws IOException when the feed cannot be read or is not a manifest - the message is shown to the user */
    UpdateManifest fetch(String url) throws IOException;
}
