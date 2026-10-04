package com.fathy.alfred.dbagent.capture;

import java.lang.ref.ReferenceQueue;
import java.lang.ref.WeakReference;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Per-object state for JDBC objects the agent did not create and must not keep alive: keys are compared by identity
 * (a driver's equals/hashCode are none of our business) and held weakly, so a statement the application forgot to
 * close is still collected - and its entry with it.
 */
final class WeakIdentityMap<V> {

    private final ConcurrentHashMap<Key, V> map = new ConcurrentHashMap<>();
    private final ReferenceQueue<Object> queue = new ReferenceQueue<>();

    V get(Object key) {
        expunge();
        return map.get(new Key(key, null));
    }

    void put(Object key, V value) {
        expunge();
        map.put(new Key(key, queue), value);
    }

    V remove(Object key) {
        expunge();
        return map.remove(new Key(key, null));
    }

    int size() {
        expunge();
        return map.size();
    }

    private void expunge() {
        Object stale;
        while ((stale = queue.poll()) != null) {
            map.remove(stale);
        }
    }

    private static final class Key extends WeakReference<Object> {
        private final int hash;

        Key(Object referent, ReferenceQueue<Object> queue) {
            super(referent, queue);
            this.hash = System.identityHashCode(referent);
        }

        @Override
        public int hashCode() {
            return hash;
        }

        @Override
        public boolean equals(Object other) {
            if (this == other) {
                return true;
            }
            if (!(other instanceof Key)) {
                return false;
            }
            Object mine = get();
            return mine != null && mine == ((Key) other).get();
        }
    }
}
