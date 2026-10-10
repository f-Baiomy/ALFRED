package com.fathy.alfred.backend.calls.application.service;

import com.fathy.alfred.backend.calls.application.port.in.SetStorageBudgetUseCase;
import com.fathy.alfred.backend.calls.application.port.out.StorageBudgetPort;
import org.springframework.stereotype.Service;

import java.util.List;

/** Only the SQLite store has a size cap; in file mode there is no StorageBudgetPort and a change waits for a restart. */
@Service
public class StorageBudgetService implements SetStorageBudgetUseCase {

    private final List<StorageBudgetPort> budgets;

    public StorageBudgetService(List<StorageBudgetPort> budgets) {
        this.budgets = budgets;
    }

    @Override
    public void setMaxSizeBytes(long bytes) {
        if (budgets.isEmpty()) {
            throw new IllegalStateException("the file store caps rows, not size");
        }
        budgets.forEach(b -> b.setMaxSizeBytes(bytes));
    }

    @Override
    public void setMaxRows(int rows) {
        if (rows < 0) {
            throw new IllegalArgumentException("the call limit cannot be negative");
        }
        if (budgets.isEmpty()) {
            throw new IllegalStateException("the file store has its own row cap");
        }
        budgets.forEach(b -> b.setMaxRows(rows));
    }

    @Override
    public void trimNow() {
        budgets.forEach(StorageBudgetPort::trimNow);
    }
}
