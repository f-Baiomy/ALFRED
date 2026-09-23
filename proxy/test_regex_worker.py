"""
Tests for regex_worker - the process that runs user regexes so a runaway one can be stopped.

Run with:  cd proxy && python -m unittest test_regex_worker -v
"""

import asyncio
import re
import time
import unittest

import regex_worker

# Catastrophic backtracking: every extra 'a' doubles the work, and the trailing 'b' guarantees
# the match fails only after trying all of it.
PATHOLOGICAL = r'(a+)+$'
PATHOLOGICAL_INPUT = 'a' * 40 + 'b'


class RegexWorkerTest(unittest.IsolatedAsyncioTestCase):

    @classmethod
    def tearDownClass(cls):
        regex_worker.shutdown()

    async def test_sub_replaces_every_match(self):
        text, n, timed_out = await regex_worker.sub(r'EUR', 0, 'USD', 'EUR 10, EUR 20')
        self.assertEqual((text, n, timed_out), ('USD 10, USD 20', 2, False))

    async def test_sub_respects_count(self):
        text, n, _ = await regex_worker.sub(r'EUR', 0, 'USD', 'EUR EUR EUR', count=1)
        self.assertEqual((text, n), ('USD EUR EUR', 1))

    async def test_group_references_work(self):
        text, _, _ = await regex_worker.sub(r'<Id>(\d+)</Id>', 0, r'<Id>X\1</Id>', '<Id>42</Id>')
        self.assertEqual(text, '<Id>X42</Id>')

    async def test_flags_are_honoured(self):
        text, n, _ = await regex_worker.sub(r'eur', re.IGNORECASE, 'USD', 'EUR')
        self.assertEqual((text, n), ('USD', 1))

    async def test_search_reports_presence(self):
        self.assertEqual(await regex_worker.search(r'\d{4}', 0, 'year 2026'), (True, False))
        self.assertEqual(await regex_worker.search(r'\d{4}', 0, 'no digits'), (False, False))

    async def test_a_runaway_pattern_times_out_and_the_worker_recovers(self):
        started = time.monotonic()
        text, n, timed_out = await regex_worker.sub(PATHOLOGICAL, 0, 'x', PATHOLOGICAL_INPUT, timeout_ms=500)
        elapsed = time.monotonic() - started
        self.assertTrue(timed_out)
        self.assertIsNone(text)
        self.assertLess(elapsed, 0.5 + 3.0, 'the timeout must actually stop the wait')
        # The killed worker was replaced: the very next request succeeds.
        text, n, timed_out = await regex_worker.sub(r'a', 0, 'b', 'aa')
        self.assertEqual((text, n, timed_out), ('bb', 2, False))

    async def test_the_event_loop_keeps_running_while_a_match_is_slow(self):
        # The point of the process: while the worker grinds, this loop still schedules other work.
        ticks = 0

        async def ticker():
            nonlocal ticks
            while True:
                await asyncio.sleep(0.02)
                ticks += 1

        task = asyncio.create_task(ticker())
        await regex_worker.sub(PATHOLOGICAL, 0, 'x', PATHOLOGICAL_INPUT, timeout_ms=400)
        task.cancel()
        self.assertGreater(ticks, 5)

    async def test_concurrent_requests_all_complete(self):
        results = await asyncio.gather(*[
            regex_worker.sub(r'\d', 0, '#', f'call {i}') for i in range(4)])
        self.assertEqual([r[0] for r in results], [f'call #' for _ in range(4)])

    async def test_an_invalid_pattern_raises_rather_than_timing_out(self):
        with self.assertRaises(ValueError):
            await regex_worker.sub(r'(unclosed', 0, 'x', 'text')


if __name__ == '__main__':
    unittest.main()
