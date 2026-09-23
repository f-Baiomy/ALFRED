"""
Runs user-supplied regular expressions in a separate process, so a pathological pattern can be
stopped.

WHY A PROCESS, NOT A THREAD: CPython's `re` holds the GIL for the whole of a match. A pattern
like `(a+)+$` against a long body can backtrack for minutes, and while it does no other Python
code in the process runs - including mitmproxy's event loop, which serves every connection this
proxy is carrying. A thread pool would therefore freeze all traffic just as surely as matching on
the loop itself. A process has its own interpreter and its own GIL, and it can be terminated.

The backend already refuses the obviously dangerous shapes at save time (nested quantifiers,
over-long patterns - see backend-interception's PatternSafety). This is the backstop for whatever
still runs long: after `timeout_ms` the worker is killed, a fresh one is started for the next
request, and the caller is told the match timed out so the action is recorded as skipped. The
body is left exactly as it was.

Literal find/replace never comes here - it is linear and runs in-process (see
interception._Pattern). Only an action the user explicitly switched to regex pays for the pipe.
"""

import asyncio
import concurrent.futures
import multiprocessing
import os
import re
import threading

DEFAULT_TIMEOUT_MS = int(os.environ.get('INTERCEPTION_REGEX_TIMEOUT_MS', '2000'))

# Compiled patterns kept inside the worker. A rule's pattern is the same on every call, so it is
# compiled once per worker rather than once per request.
_CACHE_SIZE = 64


def _serve(conn):
    """The worker's loop. Everything it receives is (op, pattern, flags, *args)."""
    cache = {}
    order = []
    while True:
        try:
            message = conn.recv()
        except (EOFError, OSError):
            return
        op, pattern, flags = message[0], message[1], message[2]
        try:
            key = (pattern, flags)
            compiled = cache.get(key)
            if compiled is None:
                compiled = re.compile(pattern, flags)
                cache[key] = compiled
                order.append(key)
                if len(order) > _CACHE_SIZE:
                    cache.pop(order.pop(0), None)
            if op == 'sub':
                replacement, text, count = message[3], message[4], message[5]
                new_text, n = compiled.subn(replacement, text, count=count)
                conn.send(('ok', new_text, n))
            elif op == 'search':
                conn.send(('ok', compiled.search(message[3]) is not None, None))
            else:
                conn.send(('error', f'unknown op {op!r}', None))
        except Exception as e:
            conn.send(('error', str(e), None))


def _context():
    # forkserver where the platform has it (Linux, which is where mitmproxy runs): cheaper than
    # spawn, and unlike fork it never copies a process that holds the event loop's locks.
    methods = multiprocessing.get_all_start_methods()
    return multiprocessing.get_context('forkserver' if 'forkserver' in methods else 'spawn')


class _Worker:
    """One persistent worker process and the pipe to it. Every exchange happens on one dedicated
    thread, so the pipe is never used by two requests at once and the event loop never blocks on
    it."""

    def __init__(self):
        self._executor = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix='regex-worker')
        self._lock = threading.Lock()
        self._process = None
        self._conn = None

    def _ensure_started(self):
        if self._process is not None and self._process.is_alive():
            return
        ctx = _context()
        parent, child = ctx.Pipe(duplex=True)
        process = ctx.Process(target=_serve, args=(child,), daemon=True, name='interception-regex')
        process.start()
        child.close()
        self._process, self._conn = process, parent

    def _restart(self):
        process, conn = self._process, self._conn
        self._process, self._conn = None, None
        try:
            if conn is not None:
                conn.close()
        finally:
            if process is not None:
                process.terminate()
                process.join(1)
                if process.is_alive():
                    process.kill()
                    process.join(1)

    def _exchange(self, message, timeout_ms):
        """Runs on the worker thread. Returns ('ok'|'error'|'timeout', value, n)."""
        with self._lock:
            self._ensure_started()
            try:
                self._conn.send(message)
                if not self._conn.poll(timeout_ms / 1000.0):
                    self._restart()
                    return ('timeout', None, None)
                return self._conn.recv()
            except (EOFError, OSError, BrokenPipeError) as e:
                # The worker died (killed, or crashed on something). Start clean next time.
                self._restart()
                return ('error', f'regex worker failed: {e}', None)

    async def run(self, message, timeout_ms):
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, self._exchange, message, timeout_ms)

    def close(self):
        with self._lock:
            self._restart()


_WORKER = _Worker()


async def sub(pattern, flags, replacement, text, count=0, timeout_ms=None):
    """`re.subn` in the worker. Returns (new_text, n, timed_out). On timeout or error new_text is
    None and the caller must leave the body untouched."""
    status, value, n = await _WORKER.run(
        ('sub', pattern, flags, replacement, text, count), timeout_ms or DEFAULT_TIMEOUT_MS)
    if status == 'ok':
        return value, n, False
    if status == 'timeout':
        return None, 0, True
    raise ValueError(value)


async def search(pattern, flags, text, timeout_ms=None):
    """Whether `pattern` occurs in `text`. Returns (found, timed_out)."""
    status, value, _ = await _WORKER.run(('search', pattern, flags, text), timeout_ms or DEFAULT_TIMEOUT_MS)
    if status == 'ok':
        return value, False
    if status == 'timeout':
        return False, True
    raise ValueError(value)


def shutdown():
    """For tests and for mitmproxy's `done` hook: stops the worker process."""
    _WORKER.close()
