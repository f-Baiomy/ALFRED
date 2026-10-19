package com.fathy.alfred.backend.linksbridge;

import java.util.List;
import java.util.Optional;

/**
 * The linked Alfred a request on this thread is being answered for (R6): set by {@link RelayLoopbackFilter} on a relayed
 * read, so any read this Alfred makes over another link while answering carries the same hops - and the far owner
 * judges it as passed on (D8), never as this Alfred's own.
 */
final class RelayContext {

    record Current(String linkId, List<String> hops, String readerName) {
    }

    private static final ThreadLocal<Current> CURRENT = new ThreadLocal<>();

    private RelayContext() {
    }

    static Optional<Current> current() {
        return Optional.ofNullable(CURRENT.get());
    }

    static List<String> hops() {
        Current c = CURRENT.get();
        return c == null ? List.of() : c.hops();
    }

    static void set(Current c) {
        CURRENT.set(c);
    }

    static void clear() {
        CURRENT.remove();
    }
}
