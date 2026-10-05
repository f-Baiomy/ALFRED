package com.fathy.alfred.dbagent.transport;

import java.util.List;

/**
 * Where a statement came from, when an ORM made it: the query the application's code wrote (HQL/JPQL, a native SQL
 * query, a Criteria query) or the Hibernate event that produced SQL on its own (a lazy collection load, an entity
 * load, a flush). Plain JDBC statements carry none. Built once when the query or event starts and shared by every
 * statement it produced - so it is never changed after it is built.
 */
public final class OriginRecord {
    /** Agent-unique; the statements of one query execution share it ("Group by query"). */
    public String id;
    /** HQL, NATIVE, CRITERIA, LAZY_LOAD, LOAD, FLUSH. */
    public String kind;
    /** The query text as the code wrote it (HQL/JPQL or SQL) - null for events. */
    public String text;
    /** A named query's name, when it was created by name. */
    public String name;
    /** The method the code called to run it: list, getResultList, executeUpdate ... */
    public String method;
    /** Bound parameters, by name or position: [name, value]. */
    public List<String[]> params;
    public Integer firstResult;
    public Integer maxResults;
    /** Events: the entity (simple name), its id, a collection role, what a flush did (INSERT/UPDATE/DELETE/...). */
    public String entity;
    public String entityId;
    public String role;
    public String action;
    /** A flushed UPDATE: the properties Hibernate found changed. */
    public List<String> changed;
    /** The id of the query this event ran inside (a fetch or auto-flush during a query). */
    public String parentId;
}
