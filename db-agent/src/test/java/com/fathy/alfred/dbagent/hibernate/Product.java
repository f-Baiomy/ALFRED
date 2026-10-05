package com.fathy.alfred.dbagent.hibernate;

import javax.persistence.Entity;
import javax.persistence.Id;
import javax.persistence.ManyToOne;
import javax.persistence.Table;

@Entity
@Table(name = "TT_PRODUCT")
public class Product {
    @Id
    public Long id;
    public String label;
    @ManyToOne
    public Org org;
}
