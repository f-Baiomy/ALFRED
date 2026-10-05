package com.fathy.alfred.dbagent;

import com.fathy.alfred.dbagent.hibernate.Org;
import com.fathy.alfred.dbagent.hibernate.Product;
import com.fathy.alfred.dbagent.transport.OriginRecord;
import com.fathy.alfred.dbagent.transport.StatementRecord;
import org.hibernate.Session;
import org.hibernate.SessionFactory;
import org.hibernate.Transaction;
import org.hibernate.cfg.Configuration;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

import static com.fathy.alfred.dbagent.AgentTestSupport.SINK;
import static com.fathy.alfred.dbagent.AgentTestSupport.inCall;
import static org.assertj.core.api.Assertions.assertThat;

/** Hibernate 5.6 on H2: every statement says which query or event of Hibernate's made it - or that the code wrote it. */
class HibernateOriginIT {

    private static SessionFactory factory;

    @BeforeAll
    static void start() {
        AgentTestSupport.reset();
        factory = new Configuration()
                .setProperty("hibernate.connection.url", "jdbc:h2:mem:" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1")
                .setProperty("hibernate.dialect", "org.hibernate.dialect.H2Dialect")
                .setProperty("hibernate.hbm2ddl.auto", "create")
                .addAnnotatedClass(Org.class)
                .addAnnotatedClass(Product.class)
                .buildSessionFactory();
        try (Session s = factory.openSession()) {
            Transaction tx = s.beginTransaction();
            Org org = new Org();
            org.id = 948L;
            org.name = "Acme";
            s.persist(org);
            for (long i = 1; i <= 3; i++) {
                Product p = new Product();
                p.id = i;
                p.label = "P" + i;
                p.org = org;
                s.persist(p);
            }
            tx.commit();
        }
    }

    @AfterAll
    static void stop() {
        factory.close();
    }

    @BeforeEach
    void setUp() {
        AgentTestSupport.reset();
    }

    private static List<StatementRecord> statements(String callId) {
        return SINK.statementsOf(callId).stream().filter(s -> s.rowsFrom == 0).sorted(java.util.Comparator.comparingInt(s -> s.seq))
                .collect(Collectors.toList());
    }

    @Test
    void hqlQueryTagsItsSqlWithTheTextParametersAndMethod() throws Exception {
        inCall("hql-1", () -> {
            try (Session s = factory.openSession()) {
                s.createQuery("select o.name from Org o where o.id = :orgId", String.class).setParameter("orgId", 948L).getResultList();
            }
        }, true);
        StatementRecord select = statements("hql-1").get(0);
        OriginRecord o = select.origin;
        assertThat(o).isNotNull();
        assertThat(o.kind).isEqualTo("HQL");
        assertThat(o.text).isEqualTo("select o.name from Org o where o.id = :orgId");
        assertThat(o.method).isEqualTo("getResultList");
        assertThat(o.params).hasSize(1);
        assertThat(o.params.get(0)).containsExactly(":orgId", "948");
        assertThat(select.sql).containsIgnoringCase("tt_org");
    }

    @Test
    void namedQueryKeepsItsName() throws Exception {
        inCall("named-1", () -> {
            try (Session s = factory.openSession()) {
                s.createNamedQuery("Org.byName", Org.class).setParameter("name", "Acme").list();
            }
        }, true);
        OriginRecord o = statements("named-1").get(0).origin;
        assertThat(o.name).isEqualTo("Org.byName");
        assertThat(o.text).isEqualTo("from Org o where o.name = :name");
        assertThat(o.params.get(0)).containsExactly(":name", "'Acme'");
    }

    @Test
    void nativeQueryKeepsTheCodesSqlAndPaging() throws Exception {
        inCall("native-1", () -> {
            try (Session s = factory.openSession()) {
                s.createNativeQuery("select label from TT_PRODUCT where org_id = :orgId order by id")
                        .setParameter("orgId", 948L).setFirstResult(1).setMaxResults(2).getResultList();
            }
        }, true);
        StatementRecord st = statements("native-1").get(0);
        assertThat(st.origin.kind).isEqualTo("NATIVE");
        assertThat(st.origin.text).isEqualTo("select label from TT_PRODUCT where org_id = :orgId order by id");
        assertThat(st.origin.firstResult).isEqualTo(1);
        assertThat(st.origin.maxResults).isEqualTo(2);
        assertThat(st.sql).isNotEqualTo(st.origin.text); // :orgId became ?, paging was added
    }

    @Test
    void entityLoadLazyCollectionAndFlushSayWhatTheyWere() throws Exception {
        inCall("events-1", () -> {
            try (Session s = factory.openSession()) {
                Transaction tx = s.beginTransaction();
                Org org = s.get(Org.class, 948L);
                org.products.size();
                org.name = "Acme 2";
                s.flush();
                org.name = "Acme";
                tx.commit();
            }
        }, true);
        List<StatementRecord> list = statements("events-1").stream().filter(s -> s.origin != null).collect(Collectors.toList());
        OriginRecord load = list.get(0).origin;
        assertThat(load.kind).isEqualTo("LOAD");
        assertThat(load.entity).isEqualTo("Org");
        assertThat(load.entityId).isEqualTo("948");
        OriginRecord lazy = list.get(1).origin;
        assertThat(lazy.kind).isEqualTo("LAZY_LOAD");
        assertThat(lazy.role).isEqualTo("Org.products");
        assertThat(lazy.entityId).isEqualTo("948");
        OriginRecord flush = list.get(2).origin;
        assertThat(flush.kind).isEqualTo("FLUSH");
        assertThat(flush.action).isEqualTo("UPDATE");
        assertThat(flush.entity).isEqualTo("Org");
        assertThat(flush.changed).containsExactly("name");
        assertThat(list.get(2).kind).isEqualTo("UPDATE");
    }

    @Test
    void eagerLoadsDuringAQueryAreParentedToIt() throws Exception {
        inCall("fetch-1", () -> {
            try (Session s = factory.openSession()) {
                List<Product> products = s.createQuery("from Product p where p.org.id = :orgId", Product.class)
                        .setParameter("orgId", 948L).list();
                assertThat(products).hasSize(3);
            }
        }, true);
        List<StatementRecord> list = statements("fetch-1");
        OriginRecord query = list.get(0).origin;
        assertThat(query.kind).isEqualTo("HQL");
        // the eager many-to-one loads Org#948 inside the query: its own LOAD, parented to the query
        OriginRecord load = list.get(1).origin;
        assertThat(load.kind).isEqualTo("LOAD");
        assertThat(load.parentId).isEqualTo(query.id);
    }

    @Test
    void plainJdbcThroughDoWorkCarriesNoOrigin() throws Exception {
        inCall("jdbc-1", () -> {
            try (Session s = factory.openSession()) {
                s.doWork(c -> {
                    try (java.sql.PreparedStatement ps = c.prepareStatement("SELECT COUNT(*) FROM TT_PRODUCT")) {
                        ps.executeQuery().close();
                    }
                });
            }
        }, true);
        assertThat(statements("jdbc-1").get(0).origin).isNull();
    }
}
