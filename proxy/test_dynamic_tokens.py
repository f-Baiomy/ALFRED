"""The shared dynamic-token vectors (specs/002-power-features/dynamic-token-vectors.json) run
here, in the frontend's dynamic-tokens.spec.ts and in the resend backend's tests - one grammar,
three resolvers, no drift."""

import datetime
import json
import os
import re
import unittest

import interception

VECTORS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'specs',
                       '002-power-features', 'dynamic-token-vectors.json')


class DynamicTokenVectorTest(unittest.TestCase):
    def test_every_vector(self):
        with open(VECTORS, encoding='utf-8') as f:
            vectors = json.load(f)
        now = datetime.datetime.fromisoformat(vectors['now'].replace('Z', '+00:00'))
        now_ms = int(now.timestamp() * 1000)
        variables = vectors['variables']
        for case in vectors['cases']:
            with self.subTest(case['input']):
                out = interception.resolve_dynamic_tokens(case['input'], variables.get, now_ms)
                if 'expect' in case:
                    self.assertEqual(out, case['expect'])
                else:
                    self.assertRegex(out, case['expectRegex'])

    def test_random_int_covers_both_ends(self):
        self.assertEqual(interception.resolve_dynamic_tokens('{{$randomInt:1:3}}', {}.get, 0, lambda: 0), '1')
        self.assertEqual(interception.resolve_dynamic_tokens('{{$randomInt:1:3}}', {}.get, 0, lambda: 0.9999), '3')


if __name__ == '__main__':
    unittest.main()
