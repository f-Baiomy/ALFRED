"""interception._replace_later: on Windows a GLOBAL capture's variables.json replace is retried off the event
loop while the other proxy has the file open, and a retry never puts older variables over a newer write."""

import os
import tempfile
import threading
import time
import unittest
from unittest import mock

import interception


def wait_for(condition, seconds=3):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(0.01)
    return False


class ReplaceLaterTest(unittest.TestCase):

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='alfred-vars-')
        self.path = os.path.join(self.dir, 'variables.json')
        with open(self.path, 'w', encoding='utf-8') as f:
            f.write('old')

    def temp(self, text):
        fd, tmp = tempfile.mkstemp(dir=self.dir, suffix='.tmp')
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(text)
        return tmp

    def read(self):
        with open(self.path, encoding='utf-8') as f:
            return f.read()

    def test_a_replace_refused_while_the_file_is_in_use_lands_once_it_is_free(self):
        tmp = self.temp('new')
        interception._LATEST_REPLACE[self.path] = tmp
        real_replace = os.replace
        calls = []

        def busy_once(src, dst):
            calls.append(src)
            if len(calls) == 1:
                raise PermissionError(13, 'Access is denied')
            real_replace(src, dst)

        with mock.patch.object(interception.os, 'replace', busy_once):
            interception._replace_later(tmp, self.path)
            self.assertTrue(wait_for(lambda: self.read() == 'new'))
        self.assertFalse(os.path.exists(tmp))

    def test_a_pending_retry_never_overwrites_a_newer_write(self):
        older, newer = self.temp('older'), self.temp('newer')
        interception._LATEST_REPLACE[self.path] = newer
        os.replace(newer, self.path)
        interception._replace_later(older, self.path)
        self.assertTrue(wait_for(lambda: not os.path.exists(older)))
        self.assertEqual(self.read(), 'newer')

    def test_the_retry_runs_off_the_calling_thread(self):
        tmp = self.temp('new')
        interception._LATEST_REPLACE[self.path] = tmp
        seen = []
        real_replace = os.replace

        def record(src, dst):
            seen.append(threading.current_thread().name)
            real_replace(src, dst)

        with mock.patch.object(interception.os, 'replace', record):
            started = time.monotonic()
            interception._replace_later(tmp, self.path)
            self.assertLess(time.monotonic() - started, 0.02)
            self.assertTrue(wait_for(lambda: seen))
        self.assertEqual(seen, ['variables-replace'])


if __name__ == '__main__':
    unittest.main()
