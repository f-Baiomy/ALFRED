package com.fathy.alfred.backend.internalcalls.application.service;

import com.fathy.alfred.backend.internalcalls.application.port.in.SetRetentionUseCase;
import com.fathy.alfred.backend.internalcalls.application.port.out.RetentionPort;
import org.springframework.stereotype.Service;

@Service
public class RetentionSettingsService implements SetRetentionUseCase {

    private final RetentionPort retention;

    public RetentionSettingsService(RetentionPort retention) {
        this.retention = retention;
    }

    @Override
    public void setRetentionRows(int rows) {
        retention.setRetentionRows(rows);
    }
}
