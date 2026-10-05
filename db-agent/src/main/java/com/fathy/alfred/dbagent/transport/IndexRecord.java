package com.fathy.alfred.dbagent.transport;

import java.util.List;

/** One index of a table, from database metadata (jdbc.IndexInspector): its name, whether unique, its columns in order. */
public final class IndexRecord {
    public String name;
    public boolean unique;
    public List<String> columns;
}
