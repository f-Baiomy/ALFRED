package com.fathy.alfred.backend.dbcapture.adapter.in.web.dto;

import com.fathy.alfred.backend.dbcapture.domain.model.IncomingStoreChunk;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.util.Base64;

/** One part of a big Redis command's bytes (specs/011-redis-capture research R4) - the agent never builds bigger parts. */
public record RedisChunkDto(
        @NotBlank @Size(max = 200) String sid,
        @NotBlank @Pattern(regexp = "args|reply|before") String which,
        @Min(0) @Max(100_000) int part,
        @Min(1) @Max(100_000) int of,
        @NotBlank @Size(max = 350_000) String data
) {
    public IncomingStoreChunk toDomain() {
        return new IncomingStoreChunk(sid, which, part, of, Base64.getDecoder().decode(data));
    }
}
