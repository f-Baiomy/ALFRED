"""Outbound attribution: which project's listener a flow came in on (specs/012-server-program).

Docker publishes each project's outboundProxyHost:outboundProxyPort to a unique internal port ("name:port"); the
native install binds the address directly, so two projects can share port 443 on different loopback addresses
("name:host:port")."""

import unittest
from unittest.mock import patch

import log_and_route


class _Conn:
    def __init__(self, sockname):
        self.sockname = sockname


class _Flow:
    def __init__(self, sockname):
        self.client_conn = _Conn(sockname)


class OutboundAttributionTest(unittest.TestCase):

    def test_parses_both_entry_shapes(self):
        by_port, by_address = log_and_route.parse_forward_proxy_port_map('a:127.0.0.3:443, b:20001,,bad,c:x:y')
        self.assertEqual(by_port, {20001: 'b'})
        self.assertEqual(by_address, {('127.0.0.3', 443): 'a'})

    def test_address_wins_then_port_then_nothing(self):
        by_port, by_address = log_and_route.parse_forward_proxy_port_map('a:127.0.0.3:443,b:127.0.0.4:443,c:20001')
        addon = log_and_route.RouteAndLog.__new__(log_and_route.RouteAndLog)
        with patch.object(log_and_route, 'FORWARD_PORT_MAP', by_port), \
                patch.object(log_and_route, 'FORWARD_ADDRESS_MAP', by_address):
            self.assertEqual(addon._attributed_service(_Flow(('127.0.0.3', 443))), 'a')
            self.assertEqual(addon._attributed_service(_Flow(('127.0.0.4', 443))), 'b')
            self.assertEqual(addon._attributed_service(_Flow(('0.0.0.0', 20001))), 'c')
            self.assertIsNone(addon._attributed_service(_Flow(('127.0.0.2', 443))))
            self.assertIsNone(addon._attributed_service(_Flow(None)))


if __name__ == '__main__':
    unittest.main()
