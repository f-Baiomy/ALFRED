package com.fathy.alfred.backend.links.application.service;

import com.fathy.alfred.backend.links.application.port.in.SignalsUseCase;
import com.fathy.alfred.backend.links.application.port.out.LinksStorePort;
import com.fathy.alfred.backend.links.application.port.out.PeerTransportPort;
import com.fathy.alfred.backend.links.application.port.out.SignalScopePort;
import com.fathy.alfred.backend.links.domain.JsonRewriter;
import com.fathy.alfred.backend.links.domain.RefTagger;
import com.fathy.alfred.backend.links.domain.model.Link;
import com.fathy.alfred.backend.links.domain.model.Stream;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Passes "something changed" signals to readers (no polling, D26): this Alfred's own, to every link with a stream they
 * concern; and a linked owner's, on to the readers this Alfred passes its cycles on to (D8), with the ids tagged so they
 * name the owner through this Alfred.
 */
@Service
public class SignalsService implements SignalsUseCase {

    /** Channels a reader never hears: none of them say anything about streamed data. */
    static final Set<String> PRIVATE = Set.of("interception", "settings", "server", "sessions", "teamboards", "relive", "scenarios", "profiles",
            "variables", "logs");

    private final LinksStorePort store;
    private final PeerTransportPort transport;
    private final ObjectProvider<SignalScopePort> scope;

    public SignalsService(LinksStorePort store, PeerTransportPort transport, ObjectProvider<SignalScopePort> scope) {
        this.store = store;
        this.transport = transport;
        this.scope = scope;
    }

    @Override
    public void local(String channel, String json) {
        forward(channel, json, null);
    }

    /** A signal from {@code from}: ids tagged with its slug, then passed to readers whose streams include its things. */
    void passOn(Link from, String channel, String json) {
        if (PRIVATE.contains(channel) || "resync".equals(channel) || "env".equals(channel) || "unlinked".equals(channel)) {
            return;
        }
        String tagged = JsonRewriter.rewrite(json, new RefTagger(from.slug()));
        forward(channel, tagged, from.id());
    }

    private void forward(String channel, String json, String exceptLinkId) {
        if (PRIVATE.contains(channel)) {
            return;
        }
        SignalScopePort s = scope.getIfAvailable();
        if (s == null) {
            return;
        }
        List<Stream> offered = store.streams().stream().filter(x -> x.mine() && x.active()).toList();
        Set<String> sent = new HashSet<>();
        for (Stream stream : offered) {
            if (stream.linkId().equals(exceptLinkId) || sent.contains(stream.linkId())) {
                continue;
            }
            boolean concerns;
            try {
                concerns = s.concerns(stream, channel, json);
            } catch (RuntimeException e) {
                concerns = false;
            }
            if (concerns) {
                sent.add(stream.linkId());
                transport.signal(stream.linkId(), channel, json);
            }
        }
    }
}
