package com.fathy.alfred.backend.dbcapture.adapter.in.web;

import com.fathy.alfred.backend.dbcapture.application.port.in.GetStoreCommandsUseCase;
import com.fathy.alfred.backend.dbcapture.application.port.in.StoreSummariesUseCase;
import com.fathy.alfred.backend.dbcapture.domain.model.CallStoreSummary;
import com.fathy.alfred.backend.dbcapture.domain.model.KeyHistoryRow;
import com.fathy.alfred.backend.dbcapture.domain.model.KeyPatternRow;
import com.fathy.alfred.backend.dbcapture.domain.model.StoreCommand;
import com.fathy.alfred.backend.dbcapture.domain.model.StoreCommandsPage;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * The Redis view's reads (specs/011-redis-capture contracts/store-commands-api.md) - under the db-capture prefix the
 * gateway already routes. Sizes are clamped in the use cases; ids lists are bounded (400 when longer).
 */
@RestController
public class DbCaptureStoreController {

    private final GetStoreCommandsUseCase commands;
    private final StoreSummariesUseCase summaries;

    public DbCaptureStoreController(GetStoreCommandsUseCase commands, StoreSummariesUseCase summaries) {
        this.commands = commands;
        this.summaries = summaries;
    }

    @GetMapping("/db-capture/calls/{callId}/store-commands")
    public StoreCommandsPage commands(@PathVariable String callId, @RequestParam(defaultValue = "0") int offset,
                                      @RequestParam(defaultValue = "500") int limit) {
        return commands.commands(callId, offset, limit);
    }

    @GetMapping("/db-capture/store-commands/{id}")
    public ResponseEntity<StoreCommand> command(@PathVariable long id, @RequestParam(defaultValue = "false") boolean raw) {
        return commands.command(id, raw).map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.notFound().build());
    }

    @GetMapping("/db-capture/calls/{callId}/store-keys")
    public List<KeyPatternRow> keys(@PathVariable String callId) {
        return commands.keys(callId);
    }

    @GetMapping("/db-capture/store-keys/history")
    public List<KeyHistoryRow> keyHistory(@RequestParam(required = false) String project, @RequestParam String key,
                                          @RequestParam(defaultValue = "50") int limit) {
        return commands.keyHistory(project == null || project.isBlank() ? null : project, key, limit);
    }

    @GetMapping(value = "/db-capture/calls/{callId}/store-commands/redis-cli", produces = MediaType.TEXT_PLAIN_VALUE)
    public String redisCli(@PathVariable String callId, @RequestParam(defaultValue = "") String seq) {
        return commands.redisCli(callId, ids(seq).stream().map(Integer::parseInt).toList());
    }

    @GetMapping("/db-capture/store/summaries")
    public Map<String, CallStoreSummary> summaries(@RequestParam(defaultValue = "") String callIds) {
        return summaries.storeSummaries(ids(callIds));
    }

    @GetMapping("/db-capture/store/failures")
    public Map<String, List<String>> failures(@RequestParam(defaultValue = "") String callIds) {
        return Map.of("redisFailedCallIds", summaries.redisFailedCallIds(ids(callIds)));
    }

    private static List<String> ids(String csv) {
        return Arrays.stream(csv.split(",")).map(String::strip).filter(s -> !s.isEmpty()).limit(1000).toList();
    }

    @ExceptionHandler({IllegalArgumentException.class})
    public ResponseEntity<Map<String, String>> invalid(IllegalArgumentException e) {
        return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
    }
}
