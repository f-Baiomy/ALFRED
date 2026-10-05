package com.fathy.alfred.dbagent.hibernate;

import javax.persistence.Entity;
import javax.persistence.Id;
import javax.persistence.NamedQuery;
import javax.persistence.OneToMany;
import javax.persistence.Table;
import java.util.ArrayList;
import java.util.List;

@Entity
@Table(name = "TT_ORG")
@NamedQuery(name = "Org.byName", query = "from Org o where o.name = :name")
public class Org {
    @Id
    public Long id;
    public String name;
    @OneToMany(mappedBy = "org")
    public List<Product> products = new ArrayList<>();
}
