package com.fathy.alfred.backend.teamboards.spi;

import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.FieldInfo;
import com.fathy.alfred.backend.teamboards.spi.model.Token;

import java.util.List;

/** Optional: the fields of a work item type, with what the project requires and allows (specs/038 FR-14). A read. */
public interface FieldCatalog {
    List<FieldInfo> fields(Connection c, Token t, String project, String type) throws ProviderException;
}
