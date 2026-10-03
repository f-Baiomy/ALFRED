package com.fathy.alfred.backend.logs.adapter.in.web;

import com.fathy.alfred.backend.logs.adapter.in.web.dto.AddInputRequestDto;
import com.fathy.alfred.backend.logs.adapter.in.web.dto.CreateUploadRequestDto;
import com.fathy.alfred.backend.logs.application.port.in.LogsException;
import com.fathy.alfred.backend.logs.application.port.in.ManageLogInputsUseCase;
import com.fathy.alfred.backend.logs.application.port.in.ManageLogSourcesUseCase;
import com.fathy.alfred.backend.logs.domain.model.LogInput;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.util.List;

/** Inputs, server files and chunked uploads (contracts/rest-api.md "Inputs"). */
@RestController
@RequestMapping("/logs")
public class LogInputsController {

    /** One upload chunk at most - under the 50 MB gateway body limit (research R10). */
    static final long MAX_CHUNK = 40L * 1024 * 1024;

    private final ManageLogInputsUseCase inputs;

    public LogInputsController(ManageLogInputsUseCase inputs) {
        this.inputs = inputs;
    }

    @GetMapping("/server-files")
    public List<ManageLogInputsUseCase.ServerFile> serverFiles(@RequestParam(defaultValue = "") String dir) {
        return inputs.serverFiles(dir);
    }

    @PostMapping("/uploads")
    @ResponseStatus(HttpStatus.CREATED)
    public ManageLogInputsUseCase.UploadTicket createUpload(@Valid @RequestBody CreateUploadRequestDto body) {
        return inputs.createUpload(body.fileName(), body.size());
    }

    @GetMapping("/uploads/{uploadId}")
    public ManageLogInputsUseCase.UploadTicket upload(@PathVariable String uploadId) {
        return inputs.uploadStatus(uploadId);
    }

    /** Raw bytes of one chunk (application/octet-stream). */
    @PutMapping("/uploads/{uploadId}/chunks/{index}")
    public ManageLogInputsUseCase.UploadTicket chunk(@PathVariable String uploadId, @PathVariable int index,
                                                    HttpServletRequest request) throws IOException {
        long length = request.getContentLengthLong();
        if (length > MAX_CHUNK) {
            throw new LogsException(LogsException.Kind.TOO_LARGE, "A chunk is at most " + MAX_CHUNK + " bytes");
        }
        if (length < 0) {
            throw LogsException.bad("Content-Length is required");
        }
        return inputs.writeChunk(uploadId, index, request.getInputStream(), length);
    }

    @PostMapping("/sources/{id}/inputs")
    @ResponseStatus(HttpStatus.CREATED)
    public LogInput add(@PathVariable String id, @Valid @RequestBody AddInputRequestDto body) {
        return inputs.add(id, body.kind(), body.ref(), body.fingerprint(), body.fromStart(), body.confirmDuplicate());
    }

    @PostMapping("/sources/{id}/inputs/{inputId}/pause")
    public LogInput pause(@PathVariable String id, @PathVariable String inputId) {
        return inputs.pause(id, inputId);
    }

    @PostMapping("/sources/{id}/inputs/{inputId}/resume")
    public LogInput resume(@PathVariable String id, @PathVariable String inputId) {
        return inputs.resume(id, inputId);
    }

    @DeleteMapping("/sources/{id}/inputs/{inputId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable String id, @PathVariable String inputId) {
        inputs.delete(id, inputId);
    }
}
