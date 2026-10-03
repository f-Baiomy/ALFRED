package com.fathy.alfred.backend.logs.adapter.in.web;

import com.fathy.alfred.backend.logs.adapter.in.web.dto.GroupsRequestDto;
import com.fathy.alfred.backend.logs.adapter.in.web.dto.MinimapRequestDto;
import com.fathy.alfred.backend.logs.adapter.in.web.dto.NodeLinesRequestDto;
import com.fathy.alfred.backend.logs.application.port.in.QueryLogsUseCase;
import com.fathy.alfred.backend.logs.domain.model.FieldStats;
import com.fathy.alfred.backend.logs.domain.model.FieldValues;
import com.fathy.alfred.backend.logs.domain.model.GroupNode;
import com.fathy.alfred.backend.logs.domain.model.Histogram;
import com.fathy.alfred.backend.logs.domain.model.LineStructures;
import com.fathy.alfred.backend.logs.domain.model.LogLine;
import com.fathy.alfred.backend.logs.domain.model.LogLineSummary;
import com.fathy.alfred.backend.logs.domain.model.LogPage;
import com.fathy.alfred.backend.logs.domain.model.LogQuery;
import com.fathy.alfred.backend.logs.domain.model.Minimap;
import com.fathy.alfred.backend.logs.domain.model.Pattern;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/** Explorer reads (contracts/rest-api.md "Querying"). A LogQuery does not fit a URL, so queries are POSTed. */
@RestController
@RequestMapping("/logs/sources/{id}")
public class LogQueryController {

    private static final int DEFAULT_GROUP_PAGE = 100;

    private final QueryLogsUseCase query;

    public LogQueryController(QueryLogsUseCase query) {
        this.query = query;
    }

    @PostMapping("/lines")
    public LogPage lines(@PathVariable String id, @RequestBody(required = false) LogQuery body) {
        return query.lines(id, body);
    }

    @GetMapping("/lines/{lineId}")
    public LogLine line(@PathVariable String id, @PathVariable String lineId) {
        return query.line(id, lineId);
    }

    @GetMapping("/lines/{lineId}/context")
    public List<LogLineSummary> context(@PathVariable String id, @PathVariable String lineId,
                                        @RequestParam(defaultValue = "20") int before, @RequestParam(defaultValue = "20") int after) {
        return query.context(id, lineId, before, after);
    }

    @PostMapping("/histogram")
    public Histogram histogram(@PathVariable String id, @RequestBody(required = false) LogQuery body,
                               @RequestParam(defaultValue = "60") int buckets) {
        return query.histogram(id, body, buckets);
    }

    @PostMapping("/fields/values")
    public FieldValues values(@PathVariable String id, @RequestBody(required = false) LogQuery body) {
        return query.fieldValues(id, body);
    }

    @PostMapping("/fields/{label}/stats")
    public FieldStats stats(@PathVariable String id, @PathVariable String label, @RequestBody(required = false) LogQuery body) {
        return query.fieldStats(id, label, body);
    }

    @PostMapping("/minimap")
    public Minimap minimap(@PathVariable String id, @Valid @RequestBody MinimapRequestDto body) {
        return query.minimap(id, body.query(), body.condition());
    }

    @GetMapping("/trace")
    public List<LogLineSummary> trace(@PathVariable String id, @RequestParam String lineId) {
        return query.trace(id, lineId);
    }

    @PostMapping("/groups")
    public List<GroupNode> groups(@PathVariable String id, @Valid @RequestBody GroupsRequestDto body) {
        return query.groups(id, body.query(), body.parentPath(), body.offset(), body.limit() <= 0 ? DEFAULT_GROUP_PAGE : body.limit());
    }

    @PostMapping("/groups/lines")
    public LogPage nodeLines(@PathVariable String id, @Valid @RequestBody NodeLinesRequestDto body) {
        return query.nodeLines(id, body.query(), body.path(), body.skipped());
    }

    @GetMapping("/fields/{label}/invalid")
    public List<LogLineSummary> invalid(@PathVariable String id, @PathVariable String label) {
        return query.invalidValues(id, label);
    }

    @PostMapping("/groups/bucket")
    public LogPage bucket(@PathVariable String id, @RequestBody(required = false) LogQuery body) {
        return query.bucket(id, body);
    }

    @PostMapping("/patterns")
    public List<Pattern> patterns(@PathVariable String id, @RequestBody(required = false) LogQuery body) {
        return query.patterns(id, body);
    }

    /** Structures among the lines with "seen in X %" per field (structure editor). */
    @GetMapping("/structures")
    public LineStructures structures(@PathVariable String id) {
        return query.structures(id, null);
    }

    /** The same, plus how many lines of each structure match the query (explorer sidebar). */
    @PostMapping("/structures")
    public LineStructures matchingStructures(@PathVariable String id, @RequestBody(required = false) LogQuery body) {
        return query.structures(id, body == null ? new LogQuery(List.of(), null, null, null, null, 0) : body);
    }
}
