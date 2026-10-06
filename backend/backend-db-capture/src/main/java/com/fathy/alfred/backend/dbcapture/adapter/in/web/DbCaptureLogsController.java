package com.fathy.alfred.backend.dbcapture.adapter.in.web;

import com.fathy.alfred.backend.dbcapture.application.port.in.CallLogLinesUseCase;
import com.fathy.alfred.backend.dbcapture.domain.model.CaughtLogLine;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * Log lines the agent caught outside any call (specs/009-agent-log-capture, US4) - the database window's "outside any
 * call" view shows them per thread. A call's own lines are served by /call-logs (the bridge). Limits clamped.
 */
@RestController
public class DbCaptureLogsController {

    private final CallLogLinesUseCase lines;

    public DbCaptureLogsController(CallLogLinesUseCase lines) {
        this.lines = lines;
    }

    @GetMapping("/db-capture/outside/logs")
    public List<CaughtLogLine> outside(@RequestParam(required = false) String project, @RequestParam(required = false) String thread,
                                       @RequestParam(defaultValue = "0") long after, @RequestParam(defaultValue = "200") int limit) {
        return lines.outside(project, thread, after, limit);
    }
}
