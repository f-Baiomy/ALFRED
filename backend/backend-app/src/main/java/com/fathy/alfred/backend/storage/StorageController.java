package com.fathy.alfred.backend.storage;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * Settings → Storage. Under the existing {@code /database} prefix, so the gateway and the native SPA filter route it
 * already. Destructive calls ({@code cleanup} with apply, {@code clear-inbound}) are confirmed by the page first.
 */
@RestController
public class StorageController {

    private final StorageService storage;
    private final StorageInsights insights;
    private final StorageBackups backups;

    public StorageController(StorageService storage, StorageInsights insights, StorageBackups backups) {
        this.storage = storage;
        this.insights = insights;
        this.backups = backups;
    }

    /** Free disk and whether it is under the warning rule - cheap, for the banner every tab shows. */
    @GetMapping("/database/storage/disk")
    public StorageService.DiskState disk() {
        return storage.diskState();
    }

    /** Where the space goes and what each day added - the Biggest and History tabs, read when they open. */
    @GetMapping("/database/storage/insights")
    public StorageInsights.Insights insights() {
        return insights.insights();
    }

    /** Deletes exactly these calls (a comment keeps a call); their captured data goes with them. */
    @PostMapping("/database/storage/delete-calls")
    public StorageService.Deleted deleteCalls(@RequestBody StorageService.DeleteRequest request) {
        return storage.deleteCalls(request);
    }

    @PutMapping("/database/storage/runs/{runId}/star")
    public Map<String, Boolean> star(@org.springframework.web.bind.annotation.PathVariable String runId,
                                     @RequestBody Map<String, Boolean> body) {
        boolean starred = Boolean.TRUE.equals(body.get("starred"));
        storage.star(runId, starred);
        return Map.of("starred", starred);
    }

    @GetMapping("/database/storage/files")
    public java.util.List<StorageService.FileHealth> files(@RequestParam(defaultValue = "false") boolean check) {
        return storage.files(check);
    }

    @PostMapping("/database/storage/checkpoint")
    public Map<String, Long> checkpoint() {
        return Map.of("freedBytes", storage.checkpointAll());
    }

    @GetMapping("/database/storage/backups")
    public StorageBackups.Backups backups() {
        return backups.list();
    }

    /** The backup, or 202 {running: true} while a big one finishes in the background. */
    @PostMapping("/database/storage/backups")
    public ResponseEntity<Object> backUp(@RequestBody Map<String, java.util.List<String>> body) {
        return backups.backUpWithin(body.get("groups"), 45)
                .<ResponseEntity<Object>>map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.accepted().body(Map.of("running", true)));
    }

    @GetMapping("/database/storage/backups/{name}")
    public ResponseEntity<org.springframework.core.io.Resource> download(@org.springframework.web.bind.annotation.PathVariable String name) {
        java.nio.file.Path file = backups.file(name);
        return ResponseEntity.ok()
                .header(org.springframework.http.HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + name + "\"")
                .contentType(org.springframework.http.MediaType.APPLICATION_OCTET_STREAM)
                .body(new org.springframework.core.io.FileSystemResource(file));
    }

    @org.springframework.web.bind.annotation.DeleteMapping("/database/storage/backups/{name}")
    public ResponseEntity<Void> deleteBackup(@org.springframework.web.bind.annotation.PathVariable String name) throws java.io.IOException {
        backups.delete(name);
        return ResponseEntity.noContent().build();
    }

    /** One raw chunk of an uploaded backup .zip; the last answers with the new backup, the others with 202. */
    @PostMapping(value = "/database/storage/backups/upload", consumes = org.springframework.http.MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public ResponseEntity<Object> upload(@RequestParam String id, @RequestParam long offset, @RequestParam long total,
                                         jakarta.servlet.http.HttpServletRequest request) throws java.io.IOException {
        return backups.receiveChunk(id, offset, total, request.getInputStream())
                .<ResponseEntity<Object>>map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.accepted().body(Map.of("received", true)));
    }

    /** Prepares a restore; it replaces the store files at the next start. */
    @PostMapping("/database/storage/backups/{name}/restore")
    public StorageBackups.Pending restore(@org.springframework.web.bind.annotation.PathVariable String name) {
        return backups.stageRestore(name);
    }

    @org.springframework.web.bind.annotation.DeleteMapping("/database/storage/restore")
    public ResponseEntity<Void> cancelRestore() {
        backups.cancelRestore();
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/database/storage")
    public StorageService.Overview overview() {
        return storage.overview();
    }

    /** Sets (or, with {@code bytes: null}, removes) the storage budget; applied at once. */
    @PutMapping("/database/storage/budget")
    public StorageService.Overview saveBudget(@RequestBody StorageBudget budget) {
        return storage.saveBudget(budget);
    }

    /** Gives empty space back - every file, or the one named. Deletes nothing. */
    @PostMapping("/database/storage/compact")
    public StorageService.Compacted compact(@RequestParam(required = false) String file) {
        return storage.compact(file);
    }

    /** What a clean-up would remove ({@code apply=false}, the dialog's live preview), or removes it. */
    @PostMapping("/database/storage/cleanup")
    public StorageService.CleanupResult cleanup(@RequestBody StorageService.CleanupRequest request,
                                                @RequestParam(defaultValue = "false") boolean apply) {
        return storage.cleanup(request, apply);
    }

    @PostMapping("/database/clear-inbound")
    public Map<String, Integer> clearInbound() {
        return Map.of("deleted", storage.clearInbound());
    }

    @PostMapping("/database/clear-user-cycles")
    public Map<String, Integer> clearUserCycles() {
        return Map.of("deleted", storage.clearUserCycles());
    }

    @ExceptionHandler({IllegalArgumentException.class, IllegalStateException.class})
    public ResponseEntity<Map<String, String>> refused(RuntimeException e) {
        return ResponseEntity.badRequest().body(Map.of("message", e.getMessage() == null ? "Refused" : e.getMessage()));
    }
}
