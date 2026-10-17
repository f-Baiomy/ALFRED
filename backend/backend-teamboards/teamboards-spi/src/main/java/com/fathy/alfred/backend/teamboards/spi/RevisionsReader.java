package com.fathy.alfred.backend.teamboards.spi;

import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.Revision;
import com.fathy.alfred.backend.teamboards.spi.model.Token;

import java.util.List;

/** Optional: a work item's history. */
public interface RevisionsReader {

    List<Revision> revisions(Connection c, Token t, String extId) throws ProviderException;
}
