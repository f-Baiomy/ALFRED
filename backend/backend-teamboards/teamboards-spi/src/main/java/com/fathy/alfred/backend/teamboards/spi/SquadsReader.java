package com.fathy.alfred.backend.teamboards.spi;

import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.Squad;
import com.fathy.alfred.backend.teamboards.spi.model.Token;

import java.util.List;

/** Optional: the provider's teams and their members. */
public interface SquadsReader {

    List<Squad> squads(Connection c, Token t) throws ProviderException;
}
