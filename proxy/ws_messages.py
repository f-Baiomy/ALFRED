"""
Per-connection batcher for WebSocket messages logged after interception has run - buffers
edited/dropped/passed-through messages and flushes a batch to backend at 50 messages or 500 ms,
whichever comes first, plus one final flush carrying `closed: true` (and the close code, if any)
when the connection ends.

Runs entirely on the addon's own asyncio event loop - flushing only means handing a plain dict to
the addon's existing fire-and-forget webhook queue (see log_and_route.py's module docstring), never
a blocking call, so this never competes with proxying for a thread.

One MessageBatcher per WebSocket connection, kept on flow.metadata['ws'] by the addon (see
log_and_route.py's websocket_start/websocket_message/websocket_end).
"""

import asyncio
import time

MAX_BATCH = 50
FLUSH_INTERVAL_SECONDS = 0.5


class MessageBatcher:
    """`push(call_id, payload)` is the addon's own queue.put_nowait, already bound to a
    ('ws-messages', call_id, payload) tuple shape - this class knows nothing about HTTP or the
    webhook queue's item format beyond that. `clock`/`sleep` are injectable for tests, which drive
    a fake clock rather than waiting on the wall clock."""

    def __init__(self, call_id, push, clock=None, sleep=None):
        self.call_id = call_id
        self._push = push
        self._clock = clock or time.monotonic
        self._sleep = sleep or asyncio.sleep
        self._seq = 0
        self._buffer = []
        self._task = None

    def start(self):
        """Begins the periodic flush loop - call once, right after construction. Idempotent no-op
        if already started (a reconnect-safety net, not expected in normal use)."""
        if self._task is None:
            self._task = asyncio.ensure_future(self._run_periodic_flush())

    async def _run_periodic_flush(self):
        while True:
            await self._sleep(FLUSH_INTERVAL_SECONDS)
            if self._buffer:
                self.flush()

    def add(self, direction, type_, content=None, content_base64=None, original_content=None, action=None):
        """One message, already decided (edited/dropped/passed through) by the caller - see
        interception.MessageVerdict. `direction` is 'client' or 'server'. `seq` increases by one
        per connection, starting at 1, regardless of how many batches it ends up split across."""
        self._seq += 1
        entry = {'seq': self._seq, 'direction': direction, 'tsMillis': int(self._clock() * 1000), 'type': type_}
        if content is not None:
            entry['content'] = content
        if content_base64 is not None:
            entry['contentBase64'] = content_base64
        if original_content is not None:
            entry['originalContent'] = original_content
        if action is not None:
            entry['action'] = action
        self._buffer.append(entry)
        if len(self._buffer) >= MAX_BATCH:
            self.flush()

    def flush(self, closed=False, close_code=None):
        """A no-op when there is nothing to say - except at close, where an empty final flush
        still carries `closed: true` so the backend knows the connection ended even if its very
        last messages were already sent in an earlier batch."""
        if not self._buffer and not closed:
            return
        payload = {'messages': self._buffer}
        if closed:
            payload['closed'] = True
            if close_code is not None:
                payload['closeCode'] = close_code
        self._buffer = []
        self._push(self.call_id, payload)

    def stop(self, closed=True, close_code=None):
        """Cancels the periodic flush loop and does the final flush - called from websocket_end."""
        if self._task is not None:
            self._task.cancel()
            self._task = None
        self.flush(closed=closed, close_code=close_code)
