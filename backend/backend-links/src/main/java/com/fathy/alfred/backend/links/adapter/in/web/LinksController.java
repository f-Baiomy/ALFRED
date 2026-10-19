package com.fathy.alfred.backend.links.adapter.in.web;

import com.fathy.alfred.backend.links.application.port.in.EnvUseCase;
import com.fathy.alfred.backend.links.application.port.in.LinkUnavailableException;
import com.fathy.alfred.backend.links.application.port.in.LinksProblem;
import com.fathy.alfred.backend.links.application.port.in.LinksUseCase;
import com.fathy.alfred.backend.links.application.port.in.PairingUseCase;
import com.fathy.alfred.backend.links.application.port.in.PresenceUseCase;
import com.fathy.alfred.backend.links.application.port.in.ReadLogUseCase;
import com.fathy.alfred.backend.links.application.port.in.RequestsUseCase;
import com.fathy.alfred.backend.links.application.port.in.StreamsUseCase;
import com.fathy.alfred.backend.links.domain.model.EnvCycle;
import com.fathy.alfred.backend.links.domain.model.EnvDef;
import com.fathy.alfred.backend.links.domain.model.EnvMark;
import com.fathy.alfred.backend.links.domain.model.EnvRetest;
import com.fathy.alfred.backend.links.domain.model.EnvStep;
import com.fathy.alfred.backend.links.domain.model.LinkRequest;
import com.fathy.alfred.backend.links.domain.model.Offer;
import com.fathy.alfred.backend.links.domain.model.Pairing;
import com.fathy.alfred.backend.links.domain.model.Presence;
import com.fathy.alfred.backend.links.domain.model.ReadEntry;
import com.fathy.alfred.backend.links.domain.model.RequestKind;
import com.fathy.alfred.backend.links.domain.model.RequestState;
import com.fathy.alfred.backend.links.domain.model.Self;
import com.fathy.alfred.backend.links.domain.model.Stream;
import com.fathy.alfred.backend.links.domain.model.StreamKind;
import com.fathy.alfred.backend.links.domain.model.StreamMode;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.request.async.DeferredResult;

import java.util.List;
import java.util.Map;

/**
 * /links (specs/035): this Alfred, its links and pairing, streams, requests, the read log, presence and environments.
 * Writes follow the board's edit rule (applied by backend-app/linksbridge) and nothing here answers through the tunnel;
 * the two pairing routes another Alfred calls ({@code POST /links/pair/offers}, its wait) prove themselves with the nonce.
 */
@RestController
@RequestMapping("/links")
public class LinksController {

    private final LinksUseCase links;
    private final PairingUseCase pairing;
    private final StreamsUseCase streams;
    private final RequestsUseCase requests;
    private final ReadLogUseCase reads;
    private final PresenceUseCase presence;
    private final EnvUseCase envs;

    public LinksController(LinksUseCase links, PairingUseCase pairing, StreamsUseCase streams, RequestsUseCase requests, ReadLogUseCase reads,
                           PresenceUseCase presence, EnvUseCase envs) {
        this.links = links;
        this.pairing = pairing;
        this.streams = streams;
        this.requests = requests;
        this.reads = reads;
        this.presence = presence;
        this.envs = envs;
    }

    // ------------------------------------------------------------------------------------------------- this Alfred

    @GetMapping("/hello")
    public LinksUseCase.Hello hello() {
        return links.hello();
    }

    @GetMapping("/discovered")
    public LinksUseCase.Discovery discovered() {
        return links.discovered();
    }

    @GetMapping("/self")
    public Self self() {
        return links.self();
    }

    public record SelfPatch(String name, Boolean announce) {
    }

    @PatchMapping("/self")
    public Self updateSelf(@RequestBody SelfPatch patch) {
        return links.updateSelf(patch.name(), patch.announce());
    }

    // ------------------------------------------------------------------------------------------------------- links

    @GetMapping
    public List<LinksUseCase.LinkInfo> list() {
        return links.links();
    }

    public record Rename(String name) {
    }

    @PatchMapping("/{id}")
    public LinksUseCase.LinkInfo rename(@PathVariable String id, @RequestBody Rename body) {
        return links.rename(id, body.name());
    }

    public record Address(String address) {
    }

    @PatchMapping("/{id}/address")
    public LinksUseCase.LinkInfo readdress(@PathVariable String id, @RequestBody Address body) {
        return links.readdress(id, body.address());
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> unlink(@PathVariable String id) {
        links.unlink(id);
        return ResponseEntity.noContent().build();
    }

    // ----------------------------------------------------------------------------------------------------- pairing

    public record PairIn(String address, String name) {
    }

    @PostMapping("/pair")
    public Pairing pair(@RequestBody PairIn body) {
        return pairing.start(body.address(), body.name());
    }

    @GetMapping("/pairings")
    public List<Pairing> pairings() {
        return pairing.pairings();
    }

    @PostMapping("/pairings/{id}/cancel")
    public ResponseEntity<Void> cancelPairing(@PathVariable String id) {
        pairing.cancel(id);
        return ResponseEntity.noContent().build();
    }

    @DeleteMapping("/pairings/{id}")
    public ResponseEntity<Void> dismissPairing(@PathVariable String id) {
        pairing.dismiss(id);
        return ResponseEntity.noContent().build();
    }

    /** Called by the Alfred that asks to link. */
    @PostMapping("/pair/offers")
    public PairingUseCase.OfferAnswer offer(@RequestBody PairingUseCase.OfferIn body, HttpServletRequest request) {
        return pairing.offer(body, request.getRemoteAddr());
    }

    @GetMapping("/pair/offers")
    public List<Offer> offers() {
        return pairing.offers();
    }

    @PostMapping("/pair/offers/{id}/accept")
    public LinksUseCase.LinkInfo accept(@PathVariable String id, @RequestBody(required = false) Rename body) {
        return pairing.accept(id, body == null ? null : body.name());
    }

    @PostMapping("/pair/offers/{id}/reject")
    public ResponseEntity<Void> reject(@PathVariable String id) {
        pairing.reject(id);
        return ResponseEntity.noContent().build();
    }

    /** Called by the Alfred that asks to link: answered when someone here answers, or WAITING after a while. */
    @GetMapping("/pair/offers/{id}/wait")
    public DeferredResult<PairingUseCase.OfferResult> await(@PathVariable String id, @RequestParam String nonce) {
        DeferredResult<PairingUseCase.OfferResult> result = new DeferredResult<>(70_000L,
                new PairingUseCase.OfferResult("WAITING", null, null, null, null));
        pairing.await(id, nonce).whenComplete((r, e) -> {
            if (e != null) {
                result.setErrorResult(e);
            } else {
                result.setResult(r);
            }
        });
        return result;
    }

    // ----------------------------------------------------------------------------------------------------- streams

    @GetMapping("/streams")
    public List<Stream> streams(@RequestParam(required = false) Boolean mine, @RequestParam(required = false) String linkId,
                                @RequestParam(required = false) StreamKind kind, @RequestParam(required = false) String target,
                                @RequestParam(defaultValue = "false") boolean ended) {
        return streams.streams(mine, linkId, kind, target, ended);
    }

    public record StreamBody(String linkId, StreamKind kind, String target, String targetName, String project, StreamMode mode,
                             Boolean autoAccept, Boolean passOn, StreamMode passMode, Boolean unmasked) {
    }

    @PostMapping("/streams")
    public Stream startStream(@RequestBody StreamBody b) {
        return streams.start(new StreamsUseCase.StreamIn(b.linkId(), b.kind(), b.target(), b.targetName(), b.project(), b.mode(),
                Boolean.TRUE.equals(b.autoAccept()), Boolean.TRUE.equals(b.passOn()), b.passMode(), Boolean.TRUE.equals(b.unmasked()), null, null));
    }

    @PatchMapping("/streams/{id}")
    public Stream updateStream(@PathVariable String id, @RequestBody StreamBody b) {
        return streams.update(id, new StreamsUseCase.StreamPatch(b.mode(), b.autoAccept(), b.passOn(), b.passMode(), b.unmasked()));
    }

    @DeleteMapping("/streams/{id}")
    public ResponseEntity<Void> stopStream(@PathVariable String id) {
        // the owner stops its stream; the reader removes its copy of one that ended
        if (streams.get(id).map(s -> !s.mine()).orElse(false)) {
            streams.forget(id);
        } else {
            streams.stop(id);
        }
        return ResponseEntity.noContent().build();
    }

    // ---------------------------------------------------------------------------------------------------- requests

    @GetMapping("/requests")
    public List<LinkRequest> requests(@RequestParam(required = false) Boolean incoming, @RequestParam(required = false) RequestState state,
                                      @RequestParam(required = false) String linkId, @RequestParam(defaultValue = "200") int limit) {
        return requests.requests(incoming, state, linkId, limit);
    }

    @GetMapping("/requests/waiting")
    public Map<String, Integer> waiting() {
        return Map.of("waiting", requests.waiting());
    }

    public record SendBody(String via, String streamId, RequestKind kind, String target, String targetLabel, String text, String extra,
                           Boolean claude) {
    }

    @PostMapping("/requests")
    public LinkRequest send(@RequestBody SendBody b) {
        return requests.send(new RequestsUseCase.SendIn(b.via(), b.streamId(), b.kind(), b.target(), b.targetLabel(), b.text(), b.extra(),
                Boolean.TRUE.equals(b.claude())));
    }

    @PostMapping("/requests/{id}/accept")
    public LinkRequest acceptRequest(@PathVariable String id) {
        return requests.accept(id);
    }

    public record Note(String note) {
    }

    @PostMapping("/requests/{id}/reject")
    public LinkRequest rejectRequest(@PathVariable String id, @RequestBody(required = false) Note body) {
        return requests.reject(id, body == null ? null : body.note());
    }

    @PostMapping("/requests/{id}/undo")
    public LinkRequest undoRequest(@PathVariable String id) {
        return requests.undo(id);
    }

    @PostMapping("/requests/{id}/withdraw")
    public LinkRequest withdrawRequest(@PathVariable String id) {
        return requests.withdraw(id);
    }

    // ------------------------------------------------------------------------------------------ read log, presence

    @GetMapping("/reads")
    public List<ReadEntry> reads(@RequestParam(required = false) String linkId, @RequestParam(defaultValue = "7") int days) {
        return reads.entries(linkId, days);
    }

    @GetMapping("/presence")
    public List<Presence> presence() {
        return presence.presence();
    }

    // ------------------------------------------------------------------------------------- environments - the host

    @GetMapping("/envs/{boardId}")
    public EnvUseCase.EnvBoard envBoard(@PathVariable String boardId) {
        return envs.board(boardId);
    }

    @GetMapping("/envs/{boardId}/defs")
    public List<EnvDef> envDefs(@PathVariable String boardId) {
        return envs.envs(boardId);
    }

    public record EnvsBody(String boardName, String project, List<EnvUseCase.EnvIn> envs) {
    }

    @PutMapping("/envs/{boardId}")
    public List<EnvDef> setEnvs(@PathVariable String boardId, @RequestBody EnvsBody b) {
        return envs.setEnvs(boardId, b.boardName(), b.project(), b.envs());
    }

    @GetMapping("/envs/{boardId}/cycles")
    public List<EnvCycle> envCycles(@PathVariable String boardId) {
        return envs.cycles(boardId);
    }

    public record TagBody(String cycleRef, String env, List<Integer> retestFor, String name) {
    }

    @PostMapping("/envs/{boardId}/cycles")
    public EnvCycle tag(@PathVariable String boardId, @RequestBody TagBody b) {
        return envs.tagCycle(boardId, b.cycleRef(), b.env(), b.retestFor(), b.name());
    }

    @DeleteMapping("/envs/{boardId}/cycles")
    public ResponseEntity<Void> untag(@PathVariable String boardId, @RequestParam String ref) {
        envs.untagCycle(boardId, ref);
        return ResponseEntity.noContent().build();
    }

    // ----------------------------------------------------------------------------- environments - an environment Alfred

    @GetMapping("/env/assignments")
    public List<EnvUseCase.Assigned> assignments() {
        return envs.assignments();
    }

    @GetMapping("/env/{slug}/{boardId}")
    public EnvUseCase.EnvColumn mine(@PathVariable String slug, @PathVariable String boardId) {
        return envs.mine(slug, boardId);
    }

    public record MarkBody(String fileName, String itemKey, String mark, String evidence, Boolean claude) {
    }

    @PutMapping("/env/{slug}/{boardId}/marks")
    public EnvMark mark(@PathVariable String slug, @PathVariable String boardId, @RequestBody MarkBody b) {
        return envs.mark(slug, boardId, b.fileName(), b.itemKey(), b.mark(), b.evidence(), Boolean.TRUE.equals(b.claude()));
    }

    @DeleteMapping("/env/{slug}/{boardId}/marks")
    public ResponseEntity<Void> clearMark(@PathVariable String slug, @PathVariable String boardId, @RequestParam String fileName,
                                          @RequestParam String itemKey) {
        envs.clearMark(slug, boardId, fileName, itemKey);
        return ResponseEntity.noContent().build();
    }

    public record StepBody(String stepKey, String state, String note, Boolean claude) {
    }

    @PutMapping("/env/{slug}/{boardId}/steps")
    public EnvStep step(@PathVariable String slug, @PathVariable String boardId, @RequestBody StepBody b) {
        return envs.step(slug, boardId, b.stepKey(), b.state(), b.note(), Boolean.TRUE.equals(b.claude()));
    }

    @DeleteMapping("/env/{slug}/{boardId}/steps")
    public ResponseEntity<Void> clearStep(@PathVariable String slug, @PathVariable String boardId, @RequestParam String stepKey) {
        envs.clearStep(slug, boardId, stepKey);
        return ResponseEntity.noContent().build();
    }

    public record RecordBody(String name, List<Integer> retestFor) {
    }

    @PostMapping("/env/{slug}/{boardId}/record")
    public EnvCycle record(@PathVariable String slug, @PathVariable String boardId, @RequestBody(required = false) RecordBody b) {
        return envs.record(slug, boardId, b == null ? null : b.name(), b == null ? null : b.retestFor());
    }

    public record RetestBody(List<Integer> cards, String cycleId, Boolean claude) {
    }

    @PostMapping("/env/{slug}/{boardId}/retest")
    public List<EnvRetest> retest(@PathVariable String slug, @PathVariable String boardId, @RequestBody(required = false) RetestBody b) {
        return envs.retest(slug, boardId, b == null ? null : b.cards(), b == null ? null : b.cycleId(), b != null && Boolean.TRUE.equals(b.claude()));
    }

    // ------------------------------------------------------------------------------------------------------ errors

    @ExceptionHandler(LinksProblem.class)
    public ResponseEntity<Map<String, String>> problem(LinksProblem p) {
        return ResponseEntity.status(p.status()).body(Map.of("error", p.code(), "message", p.getMessage() == null ? "" : p.getMessage()));
    }

    @ExceptionHandler(LinkUnavailableException.class)
    public ResponseEntity<Map<String, String>> unavailable(LinkUnavailableException e) {
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(Map.of("error", e.code(), "message",
                e.getMessage() == null ? "" : e.getMessage(), "slug", e.slug() == null ? "" : e.slug()));
    }

    @ExceptionHandler(IllegalArgumentException.class)
    public ResponseEntity<Map<String, String>> bad(IllegalArgumentException e) {
        return ResponseEntity.badRequest().body(Map.of("error", "BAD_REQUEST", "message", e.getMessage() == null ? "" : e.getMessage()));
    }
}
