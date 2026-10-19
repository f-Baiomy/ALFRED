package com.fathy.alfred.backend.linksbridge;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.fathy.alfred.backend.board.application.port.out.CallFactsPort;
import com.fathy.alfred.backend.board.domain.model.CallFacts;
import com.fathy.alfred.backend.board.domain.model.CycleCall;
import com.fathy.alfred.backend.links.application.port.in.BlockingResponse;
import com.fathy.alfred.backend.links.application.port.in.LinkUnavailableException;
import com.fathy.alfred.backend.links.application.port.in.LinksUseCase;
import com.fathy.alfred.backend.links.application.port.in.RelayRequest;
import com.fathy.alfred.backend.links.application.port.in.RelayUseCase;
import com.fathy.alfred.backend.links.application.port.in.StreamsUseCase;
import com.fathy.alfred.backend.links.domain.RemoteRef;
import com.fathy.alfred.backend.links.domain.model.Link;
import com.fathy.alfred.backend.links.domain.model.Stream;
import com.fathy.alfred.backend.links.domain.model.StreamKind;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.Set;

/**
 * The board's reads of a cycle another Alfred streams (D25): its calls signed by the owner, a call's facts and bodies,
 * the cycle's name. A remote cycle is {@code <id>@<slug>}; its calls keep the owner's own ids and are always read with
 * the cycle's ref, so the board's call refs stay {@code in:<call>@<cycle>@<slug>}. Offline answers nothing (D21) - the
 * board says "offline", never fails.
 */
@Component
public class RemoteBoardData {

    static final Duration WAIT = Duration.ofSeconds(30);
    static final int MAX_JSON = 64 * 1024 * 1024;

    public record CycleInfo(String id, String name, String project, boolean recording, String status) {
    }

    private final ObjectProvider<RelayUseCase> relay;
    private final ObjectProvider<StreamsUseCase> streams;
    private final ObjectProvider<LinksUseCase> links;
    private final ObjectMapper json = JsonMapper.builder().addModule(new JavaTimeModule())
            .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES).build();

    public RemoteBoardData(ObjectProvider<RelayUseCase> relay, ObjectProvider<StreamsUseCase> streams, ObjectProvider<LinksUseCase> links) {
        this.relay = relay;
        this.streams = streams;
        this.links = links;
    }

    /** The link and the owner's own id of a ref, when the ref names a linked Alfred's thing. */
    public Optional<RemoteRef.Split> remote(String ref) {
        RelayUseCase r = relay.getIfAvailable();
        if (r == null || ref == null) {
            return Optional.empty();
        }
        return RemoteRef.outer(ref).filter(sp -> r.knows(sp.slug()));
    }

    public boolean isRemote(String ref) {
        return remote(ref).isPresent();
    }

    private Optional<JsonNode> fetch(String slug, String path, String query) {
        RelayUseCase r = relay.getIfAvailable();
        if (r == null) {
            return Optional.empty();
        }
        try {
            BlockingResponse.Whole w = r.fetch(slug, RelayRequest.get(path, query).withHops(RelayContext.hops()), WAIT, MAX_JSON);
            if (w.status() >= 400) {
                return Optional.empty();
            }
            return Optional.of(json.readTree(w.body()));
        } catch (LinkUnavailableException | IOException e) {
            return Optional.empty();
        }
    }

    /**
     * How far the other Alfred's clock is ahead of this one's, measured on the link (0 when unknown or under a second -
     * the ping's own noise).
     */
    long clockOffsetMs(String slug) {
        LinksUseCase l = links.getIfAvailable();
        if (l == null) {
            return 0;
        }
        Long offset = l.bySlug(slug).map(link -> l.state(link.id()).clockOffsetMs()).orElse(null);
        return offset == null || Math.abs(offset) < 1000 ? 0 : offset;
    }

    private static String enc(String s) {
        return URLEncoder.encode(s, StandardCharsets.UTF_8);
    }

    public List<CycleCall> cycleCalls(String cycleRef, int limit) {
        Optional<RemoteRef.Split> sp = remote(cycleRef);
        if (sp.isEmpty()) {
            return List.of();
        }
        List<CycleCall> out = new ArrayList<>();
        long offset = clockOffsetMs(sp.get().slug());
        fetch(sp.get().slug(), "/links/data/cycle-calls", "cycleId=" + enc(sp.get().inner()) + "&limit=" + limit).ifPresent(n -> {
            for (JsonNode c : n) {
                try {
                    CycleCall call = json.treeToValue(c, CycleCall.class);
                    // its time on this Alfred's clock: "calls since the fix" compares it with this Alfred's fix time
                    out.add(offset == 0 || call.at() == null ? call : new CycleCall(call.direction(), call.callId(), call.method(), call.path(),
                            call.status(), call.signature(), call.at().minusMillis(offset), call.durationMs()));
                } catch (IOException | IllegalArgumentException e) {
                    // a call this Alfred cannot read is left out of judging
                }
            }
        });
        return out;
    }

    public Optional<CallFacts> facts(String callId, String cycleRef, Set<String> jsonPaths) {
        Optional<RemoteRef.Split> sp = remote(cycleRef);
        if (sp.isEmpty()) {
            return Optional.empty();
        }
        String paths = String.join("\n", jsonPaths == null ? Set.of() : jsonPaths);
        return fetch(sp.get().slug(), "/links/data/call-facts", "callId=" + enc(callId) + "&cycleId=" + enc(sp.get().inner()) + "&paths=" + enc(paths))
                .flatMap(n -> {
                    try {
                        return Optional.of(json.treeToValue(n, CallFacts.class));
                    } catch (IOException | IllegalArgumentException e) {
                        return Optional.empty();
                    }
                });
    }

    public Optional<CallFactsPort.CallBodies> bodies(String callId, String cycleRef) {
        Optional<RemoteRef.Split> sp = remote(cycleRef);
        if (sp.isEmpty()) {
            return Optional.empty();
        }
        return fetch(sp.get().slug(), "/links/data/call-bodies", "callId=" + enc(callId) + "&cycleId=" + enc(sp.get().inner())).flatMap(n -> {
            try {
                return Optional.of(json.treeToValue(n, CallFactsPort.CallBodies.class));
            } catch (IOException | IllegalArgumentException e) {
                return Optional.empty();
            }
        });
    }

    /** The cycle's name from this Alfred's copy of its stream (no network), else asked of the owner. */
    public Optional<String> name(String cycleRef) {
        Optional<RemoteRef.Split> sp = remote(cycleRef);
        if (sp.isEmpty()) {
            return Optional.empty();
        }
        Optional<Stream> mirror = mirror(sp.get());
        if (mirror.isPresent() && mirror.get().targetName() != null) {
            return Optional.of(mirror.get().targetName());
        }
        return cycle(cycleRef).map(CycleInfo::name);
    }

    public Optional<Stream> mirror(RemoteRef.Split sp) {
        StreamsUseCase s = streams.getIfAvailable();
        LinksUseCase l = links.getIfAvailable();
        if (s == null || l == null) {
            return Optional.empty();
        }
        Optional<Link> link = l.bySlug(sp.slug());
        if (link.isEmpty()) {
            return Optional.empty();
        }
        return s.streams(false, link.get().id(), StreamKind.CYCLE, sp.inner(), true).stream().findFirst();
    }

    public Optional<CycleInfo> cycle(String cycleRef) {
        Optional<RemoteRef.Split> sp = remote(cycleRef);
        if (sp.isEmpty()) {
            return Optional.empty();
        }
        return fetch(sp.get().slug(), "/links/data/cycle", "cycleId=" + enc(sp.get().inner())).flatMap(n -> {
            try {
                return Optional.of(json.treeToValue(n, CycleInfo.class));
            } catch (IOException | IllegalArgumentException e) {
                return Optional.empty();
            }
        });
    }

    /** Whether the remote cycle is still streamed to this Alfred (or reachable through a board stream). */
    public boolean exists(String cycleRef) {
        Optional<RemoteRef.Split> sp = remote(cycleRef);
        if (sp.isEmpty()) {
            return false;
        }
        Optional<Stream> m = mirror(sp.get());
        return m.map(Stream::active).orElse(true);
    }

    /** The owner's project of a remote cycle (its stream's), for the requirement watch. */
    public Optional<String> project(String cycleRef) {
        return remote(cycleRef).flatMap(this::mirror).map(Stream::project);
    }
}
