package com.fathy.alfred.dbagent.capture;

import com.fathy.alfred.dbagent.transport.OriginRecord;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;

import static org.assertj.core.api.Assertions.assertThat;

class OriginTrackerTest {

    /** Stands in for Hibernate's org.hibernate.impl.QueryImpl: its query text behind a public getter. */
    public static class FakeQuery {
        private final String text;

        public FakeQuery(String text) {
            this.text = text;
        }

        public String getQueryString() {
            return text;
        }
    }

    /** One deployment's own copy of FakeQuery - same name, a different class (what each WAR's hibernate-core is). */
    private static final class Deployment extends ClassLoader {
        Deployment() {
            super(OriginTrackerTest.class.getClassLoader());
        }

        @Override
        protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
            if (!name.equals(FakeQuery.class.getName())) {
                return super.loadClass(name, resolve);
            }
            synchronized (getClassLoadingLock(name)) {
                Class<?> loaded = findLoadedClass(name);
                if (loaded != null) {
                    return loaded;
                }
                try (InputStream in = getParent().getResourceAsStream(name.replace('.', '/') + ".class")) {
                    ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                    byte[] buffer = new byte[4096];
                    for (int n; (n = in.read(buffer)) > 0; ) {
                        bytes.write(buffer, 0, n);
                    }
                    byte[] b = bytes.toByteArray();
                    return defineClass(name, b, 0, b.length);
                } catch (IOException e) {
                    throw new ClassNotFoundException(name, e);
                }
            }
        }
    }

    private static Object queryIn(Deployment deployment, String text) throws Exception {
        return deployment.loadClass(FakeQuery.class.getName()).getConstructor(String.class).newInstance(text);
    }

    private static String textOf(OriginTracker tracker, Object query) {
        Object token = tracker.queryEnter(query, "list");
        OriginRecord origin = tracker.current();
        tracker.exit(token);
        return origin.text;
    }

    @Test
    void twoDeploymentsWithTheirOwnHibernateBothKeepTheirQueryText() throws Exception {
        Deployment admin = new Deployment();
        Deployment portal = new Deployment();
        Object portalQuery = queryIn(portal, "from Agency a where a.id = ?");
        Object adminQuery = queryIn(admin, "from User u where u.id = ?");
        assertThat(adminQuery.getClass().getName()).isEqualTo(portalQuery.getClass().getName());
        assertThat(adminQuery.getClass()).isNotSameAs(portalQuery.getClass());

        OriginTracker tracker = new OriginTracker("agent-1");
        // The portal runs a query first; the admin's queries must not be read through the portal's class.
        assertThat(textOf(tracker, portalQuery)).isEqualTo("from Agency a where a.id = ?");
        assertThat(textOf(tracker, adminQuery)).isEqualTo("from User u where u.id = ?");
        assertThat(textOf(tracker, portalQuery)).isEqualTo("from Agency a where a.id = ?");
    }
}
