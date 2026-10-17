package com.fathy.alfred.backend.teamboards.spi;

import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.Sprint;
import com.fathy.alfred.backend.teamboards.spi.model.Token;

import java.util.List;

/** Optional: the provider's sprints. */
public interface SprintsReader {

    List<Sprint> sprints(Connection c, Token t) throws ProviderException;
}
