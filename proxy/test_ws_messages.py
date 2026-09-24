"""Tests for ws_messages.MessageBatcher - pure stdlib unittest, matching test_interception.py's
own conventions (see its module docstring)."""

import unittest

import ws_messages


class FakeClock:
    def __init__(self, start=0.0):
        self.now = start

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class FakeSleep:
    """Replaces asyncio.sleep: each call blocks until test code calls release() for it, so a test
    can step the batcher's periodic flush loop deterministically instead of racing the real clock."""

    def __init__(self):
        self._waiters = []

    async def __call__(self, _seconds):
        import asyncio
        fut = asyncio.get_event_loop().create_future()
        self._waiters.append(fut)
        await fut

    def release_one(self):
        if self._waiters:
            self._waiters.pop(0).set_result(None)


class FakeQueue:
    def __init__(self):
        self.items = []

    def put(self, call_id, payload):
        self.items.append((call_id, payload))


class MessageBatcherTest(unittest.IsolatedAsyncioTestCase):

    def batcher(self, call_id='c1'):
        queue = FakeQueue()
        clock = FakeClock()
        batcher = ws_messages.MessageBatcher(call_id, queue.put, clock=clock)
        return batcher, queue, clock

    def test_flushes_at_50_messages(self):
        batcher, queue, clock = self.batcher()
        for i in range(49):
            batcher.add('client', 'text', content=str(i))
        self.assertEqual(queue.items, [])

        batcher.add('client', 'text', content='49')
        self.assertEqual(len(queue.items), 1)
        self.assertEqual(len(queue.items[0][1]['messages']), 50)
        self.assertNotIn('closed', queue.items[0][1])

    def test_flushes_at_500ms_via_the_periodic_loop(self):
        async def run():
            queue = FakeQueue()
            clock = FakeClock()
            fake_sleep = FakeSleep()
            import asyncio
            batcher = ws_messages.MessageBatcher('c1', queue.put, clock=clock, sleep=fake_sleep)
            batcher.start()
            await asyncio.sleep(0)  # let the periodic task reach its first await point
            batcher.add('client', 'text', content='hi')
            self.assertEqual(queue.items, [])

            clock.advance(0.5)
            fake_sleep.release_one()
            # Let the periodic task actually run past its await point.
            for _ in range(5):
                await asyncio.sleep(0)

            self.assertEqual(len(queue.items), 1)
            self.assertEqual(queue.items[0][1]['messages'][0]['content'], 'hi')
            batcher.stop(closed=False)

        import asyncio
        asyncio.run(run())

    async def test_closed_true_is_sent_at_the_end(self):
        queue = FakeQueue()
        clock = FakeClock()
        batcher = ws_messages.MessageBatcher('c1', queue.put, clock=clock)
        batcher.add('client', 'text', content='hi')

        batcher.stop(closed=True, close_code=1000)

        self.assertEqual(len(queue.items), 1)
        self.assertTrue(queue.items[0][1]['closed'])
        self.assertEqual(queue.items[0][1]['closeCode'], 1000)

    async def test_a_final_flush_with_nothing_buffered_still_sends_closed(self):
        queue = FakeQueue()
        batcher = ws_messages.MessageBatcher('c1', queue.put)

        batcher.stop(closed=True)

        self.assertEqual(len(queue.items), 1)
        self.assertEqual(queue.items[0][1]['messages'], [])
        self.assertTrue(queue.items[0][1]['closed'])

    async def test_seq_increases_per_connection_across_batches(self):
        queue = FakeQueue()
        batcher = ws_messages.MessageBatcher('c1', queue.put)
        for i in range(60):
            batcher.add('client', 'text', content=str(i))
        batcher.stop(closed=True)

        all_seqs = [m['seq'] for _, payload in queue.items for m in payload['messages']]
        self.assertEqual(all_seqs, list(range(1, 61)))

    async def test_binary_messages_carry_base64_not_content(self):
        queue = FakeQueue()
        batcher = ws_messages.MessageBatcher('c1', queue.put)
        batcher.add('server', 'binary', content_base64='AAA=')
        batcher.stop(closed=True)

        message = queue.items[0][1]['messages'][0]
        self.assertEqual(message['contentBase64'], 'AAA=')
        self.assertNotIn('content', message)


if __name__ == '__main__':
    unittest.main()
