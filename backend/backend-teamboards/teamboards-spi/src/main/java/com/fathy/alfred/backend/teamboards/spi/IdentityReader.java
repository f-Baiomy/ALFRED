package com.fathy.alfred.backend.teamboards.spi;

import com.fathy.alfred.backend.teamboards.spi.model.Connection;
import com.fathy.alfred.backend.teamboards.spi.model.Person;
import com.fathy.alfred.backend.teamboards.spi.model.Token;

import java.util.Collection;
import java.util.List;

/** Optional: who owns the token, and people by id (team members are ids until resolved). */
public interface IdentityReader {
    Person whoAmI(Connection c, Token t) throws ProviderException;

    List<Person> peopleById(Connection c, Token t, Collection<String> ids) throws ProviderException;
}
