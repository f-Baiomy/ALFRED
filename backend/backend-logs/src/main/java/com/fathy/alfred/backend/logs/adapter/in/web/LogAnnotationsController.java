package com.fathy.alfred.backend.logs.adapter.in.web;

import com.fathy.alfred.backend.logs.adapter.in.web.dto.CommentRequestDto;
import com.fathy.alfred.backend.logs.adapter.in.web.dto.SaveViewRequestDto;
import com.fathy.alfred.backend.logs.adapter.in.web.dto.SelectionRequestDto;
import com.fathy.alfred.backend.logs.application.port.in.AnnotateLogsUseCase;
import com.fathy.alfred.backend.logs.domain.model.LogComment;
import com.fathy.alfred.backend.logs.domain.model.SavedView;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/** Comments, pins and saved views (contracts/rest-api.md "Selection, comments, saved views"). */
@RestController
@RequestMapping("/logs/sources/{id}")
public class LogAnnotationsController {

    private final AnnotateLogsUseCase annotate;

    public LogAnnotationsController(AnnotateLogsUseCase annotate) {
        this.annotate = annotate;
    }

    @GetMapping("/lines/{lineId}/comments")
    public List<LogComment> comments(@PathVariable String id, @PathVariable String lineId) {
        return annotate.comments(id, lineId);
    }

    @PostMapping("/lines/{lineId}/comments")
    @ResponseStatus(HttpStatus.CREATED)
    public LogComment comment(@PathVariable String id, @PathVariable String lineId, @Valid @RequestBody CommentRequestDto body) {
        return annotate.comment(id, lineId, body.path(), body.text(), body.authorProfileId());
    }

    @DeleteMapping("/comments/{commentId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void deleteComment(@PathVariable String id, @PathVariable String commentId) {
        annotate.deleteComment(id, commentId);
    }

    @PostMapping("/selection/comment")
    public Map<String, Long> commentAll(@PathVariable String id, @Valid @RequestBody SelectionRequestDto body) {
        return Map.of("commented", annotate.commentAll(id, new AnnotateLogsUseCase.Selection(body.lineIds(), body.allMatching()),
                body.text(), body.authorProfileId()));
    }

    @PostMapping("/selection/pin")
    public Map<String, Long> pin(@PathVariable String id, @Valid @RequestBody SelectionRequestDto body) {
        return Map.of("pinned", annotate.pin(id, new AnnotateLogsUseCase.Selection(body.lineIds(), body.allMatching())));
    }

    @GetMapping("/views")
    public List<SavedView> views(@PathVariable String id) {
        return annotate.views(id);
    }

    @PostMapping("/views")
    @ResponseStatus(HttpStatus.CREATED)
    public SavedView saveView(@PathVariable String id, @Valid @RequestBody SaveViewRequestDto body) {
        return annotate.saveView(id, body.name(), body.state());
    }

    @DeleteMapping("/views/{viewId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void deleteView(@PathVariable String id, @PathVariable String viewId) {
        annotate.deleteView(id, viewId);
    }
}
