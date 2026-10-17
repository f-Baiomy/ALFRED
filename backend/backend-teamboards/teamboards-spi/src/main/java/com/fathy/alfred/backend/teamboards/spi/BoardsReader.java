package com.fathy.alfred.backend.teamboards.spi;

import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.ProviderBoard;
import com.fathy.alfred.backend.teamboards.spi.model.Token;

import java.util.List;

/** Optional: the provider's boards. */
public interface BoardsReader {

    List<ProviderBoard> boards(Connection c, Token t) throws ProviderException;
}
