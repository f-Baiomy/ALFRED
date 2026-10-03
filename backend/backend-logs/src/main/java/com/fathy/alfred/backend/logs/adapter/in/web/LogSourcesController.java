package com.fathy.alfred.backend.logs.adapter.in.web;

import com.fathy.alfred.backend.logs.adapter.in.web.dto.CreateSourceRequestDto;
import com.fathy.alfred.backend.logs.adapter.in.web.dto.PreviewRequestDto;
import com.fathy.alfred.backend.logs.adapter.in.web.dto.SplitRequestDto;
import com.fathy.alfred.backend.logs.adapter.in.web.dto.StructureSettingsRequestDto;
import com.fathy.alfred.backend.logs.adapter.in.web.dto.UpdateSourceRequestDto;
import com.fathy.alfred.backend.logs.application.port.in.ManageLogSourcesUseCase;
import com.fathy.alfred.backend.logs.domain.model.LogStructure;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/** Log sources and their structure (contracts/rest-api.md "Sources and structure"). */
@RestController
@RequestMapping("/logs")
public class LogSourcesController {

    private final ManageLogSourcesUseCase sources;

    public LogSourcesController(ManageLogSourcesUseCase sources) {
        this.sources = sources;
    }

    @GetMapping("/sources")
    public List<ManageLogSourcesUseCase.SourceView> list() {
        return sources.list();
    }

    @GetMapping("/sources/{id}")
    public ManageLogSourcesUseCase.SourceView get(@PathVariable String id) {
        return sources.get(id);
    }

    @PostMapping("/structure/preview")
    public ManageLogSourcesUseCase.Preview preview(@Valid @RequestBody PreviewRequestDto body) {
        return sources.preview(body.sampleLines(), body.serverPath());
    }

    @PostMapping("/sources")
    @ResponseStatus(HttpStatus.CREATED)
    public ManageLogSourcesUseCase.SourceView create(@Valid @RequestBody CreateSourceRequestDto body) {
        return sources.create(body.name(), body.rawMode(), body.privacyMode(), body.structure());
    }

    @PatchMapping("/sources/{id}")
    public ManageLogSourcesUseCase.SourceView update(@PathVariable String id, @Valid @RequestBody UpdateSourceRequestDto body) {
        return sources.update(id, body.name(), body.retentionMaxBytes());
    }

    @GetMapping("/sources/{id}/delete-impact")
    public ManageLogSourcesUseCase.DeleteImpact deleteImpact(@PathVariable String id) {
        return sources.deleteImpact(id);
    }

    @DeleteMapping("/sources/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable String id) {
        sources.delete(id);
    }

    @GetMapping("/sources/{id}/structure")
    public LogStructure structure(@PathVariable String id) {
        return sources.structure(id);
    }

    @PutMapping("/sources/{id}/structure")
    public LogStructure updateStructure(@PathVariable String id, @RequestBody LogStructure body) {
        return sources.updateStructure(id, body);
    }

    @PatchMapping("/sources/{id}/structures/{structureId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void updateStructureSettings(@PathVariable String id, @PathVariable int structureId,
                                        @Valid @RequestBody StructureSettingsRequestDto body) {
        sources.updateStructureSettings(id, structureId, body.name(), body.template());
    }

    @PostMapping("/sources/{id}/structures/{structureId}/move")
    @ResponseStatus(HttpStatus.CREATED)
    public ManageLogSourcesUseCase.SourceView moveStructure(@PathVariable String id, @PathVariable int structureId,
                                                            @Valid @RequestBody SplitRequestDto body) {
        return sources.moveStructure(id, structureId, body.name());
    }
}
