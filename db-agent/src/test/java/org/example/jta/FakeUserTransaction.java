package org.example.jta;

import javax.transaction.UserTransaction;

/**
 * A container's UserTransaction, as far as the agent can tell: only the type and commit/rollback matter. Outside the
 * agent's own package on purpose - the agent never instruments com.fathy.alfred.dbagent.*.
 */
public final class FakeUserTransaction implements UserTransaction {
    @Override
    public void begin() {
    }

    @Override
    public void commit() {
    }

    @Override
    public void rollback() {
    }

    @Override
    public void setRollbackOnly() {
    }

    @Override
    public int getStatus() {
        return 0;
    }

    @Override
    public void setTransactionTimeout(int seconds) {
    }
}
