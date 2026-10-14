package com.fathy.alfred.backend.board.application.service;

import com.fathy.alfred.backend.board.application.port.out.BoardNotificationPort;
import com.fathy.alfred.backend.board.domain.model.AgentStatus;
import com.fathy.alfred.backend.board.domain.model.LiveWork;
import com.fathy.alfred.backend.board.domain.model.SkillRun;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Tells waiters (Claude's board_wait) that the board changed - the same moment /ws/board is signalled, never a timer.
 * Each listener is called once, on the next change, and is then gone; a waiter that still has nothing to report
 * subscribes again.
 */
@Component
public class BoardChangeFeed {

    private static final Logger log = LoggerFactory.getLogger(BoardChangeFeed.class);

    private final CopyOnWriteArrayList<Runnable> listeners = new CopyOnWriteArrayList<>();

    public AutoCloseable once(Runnable listener) {
        listeners.add(listener);
        return () -> listeners.remove(listener);
    }

    public void fire() {
        for (Runnable listener : listeners) {
            if (listeners.remove(listener)) {
                try {
                    listener.run();
                } catch (RuntimeException e) {
                    log.warn("A board change listener failed: {}", e.toString());
                }
            }
        }
    }

    int waiting() {
        return listeners.size();
    }

    /** The services' notification port, also firing this feed after every "board changed" signal. */
    BoardNotificationPort feeding(BoardNotificationPort notifications) {
        return new BoardNotificationPort() {
            @Override
            public void changed(String project, String cycleId, String cardId, String what) {
                notifications.changed(project, cycleId, cardId, what);
                fire();
            }

            @Override
            public void agentStatus(AgentStatus status) {
                notifications.agentStatus(status);
            }

            @Override
            public void liveWork(LiveWork work) {
                notifications.liveWork(work);
            }

            @Override
            public void liveRunner(String project, String host, String kind) {
                notifications.liveRunner(project, host, kind);
            }

            @Override
            public void cycleChat(String project, String cycleId) {
                notifications.cycleChat(project, cycleId);
            }

            @Override
            public void skillRun(SkillRun run) {
                notifications.skillRun(run);
            }
        };
    }
}
