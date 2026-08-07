package com.alfred.pennyworth;

import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/comments")
public class CommentsController {

    private final CommentsRepository repository;

    public CommentsController(CommentsRepository repository) {
        this.repository = repository;
    }

    @GetMapping
    public List<CommentDto> list(@RequestParam String callId) {
        return repository.findByCallId(callId);
    }

    @PostMapping
    public CommentDto create(@RequestBody CommentRequestDto request) {
        return repository.create(request);
    }

    @DeleteMapping("/{id}")
    public void delete(@PathVariable String id) {
        repository.deleteById(id);
    }
}
