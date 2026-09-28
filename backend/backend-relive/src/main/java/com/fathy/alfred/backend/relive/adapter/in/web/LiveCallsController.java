package com.fathy.alfred.backend.relive.adapter.in.web;

import com.fathy.alfred.backend.relive.adapter.in.web.dto.LiveCallDetailDto;
import com.fathy.alfred.backend.relive.adapter.in.web.dto.UseAsRecordingRequestDto;
import com.fathy.alfred.backend.relive.application.port.in.ManageReliveCyclesUseCase;
import com.fathy.alfred.backend.relive.application.port.in.UseLiveCallAsRecordingUseCase;
import com.fathy.alfred.backend.relive.application.port.out.LiveCallStorePort;
import com.fathy.alfred.backend.relive.domain.model.CycleVariable;
import com.fathy.alfred.backend.relive.domain.model.LiveCall;
import com.fathy.alfred.backend.relive.domain.model.ReliveCycle;
import com.fathy.alfred.backend.relive.domain.model.ReliveLimits;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;

/** REST surface for the Live calls log (FR-015b/c; contracts/rest-api.md, T073). */
@RestController
@RequestMapping("/relive-cycles")
public class LiveCallsController {

    private final LiveCallStorePort liveCallStore;
    private final ManageReliveCyclesUseCase manageCycles;
    private final UseLiveCallAsRecordingUseCase useAsRecording;

    public LiveCallsController(LiveCallStorePort liveCallStore, ManageReliveCyclesUseCase manageCycles,
                                UseLiveCallAsRecordingUseCase useAsRecording) {
        this.liveCallStore = liveCallStore;
        this.manageCycles = manageCycles;
        this.useAsRecording = useAsRecording;
    }

    @GetMapping("/{id}/live-calls")
    public ResponseEntity<List<LiveCall>> list(@PathVariable String id, @RequestParam(required = false, defaultValue = "100") int limit) {
        List<LiveCall> calls = liveCallStore.list(id, Math.min(Math.max(limit, 0), ReliveLimits.MAX_LIST_LIMIT));
        return ResponseEntity.ok()
                .header("X-Live-Calls-Bytes", String.valueOf(liveCallStore.totalBytes(id)))
                .body(calls);
    }

    @GetMapping("/{id}/live-calls/{liveId}")
    public ResponseEntity<LiveCallDetailDto> get(@PathVariable String id, @PathVariable String liveId) {
        return liveCallStore.findById(liveId)
                .map(call -> new LiveCallDetailDto(call, secretsOf(id)))
                .map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @DeleteMapping("/{id}/live-calls/{liveId}")
    public ResponseEntity<Void> delete(@PathVariable String id, @PathVariable String liveId) {
        return liveCallStore.deleteById(liveId) ? ResponseEntity.noContent().build() : ResponseEntity.notFound().build();
    }

    @PostMapping("/{id}/live-calls/{liveId}/use-as-recording")
    public ReliveCycle useAsRecording(@PathVariable String id, @PathVariable String liveId, @RequestBody UseAsRecordingRequestDto body) {
        try {
            return useAsRecording.useAsRecording(id, liveId, body.stepKey());
        } catch (IllegalArgumentException e) {
            throw new ResponseStatusException(org.springframework.http.HttpStatus.NOT_FOUND, e.getMessage(), e);
        }
    }

    private List<String> secretsOf(String cycleId) {
        return manageCycles.get(cycleId)
                .map(ReliveCycle::variables)
                .map(vars -> vars.stream().filter(CycleVariable::secret).map(CycleVariable::name).toList())
                .orElse(List.of());
    }
}
