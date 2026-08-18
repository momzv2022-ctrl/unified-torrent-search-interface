"""Test double for `socks`, imported by the real `helpers`."""

PROXY_TYPE_SOCKS4 = 1
PROXY_TYPE_SOCKS5 = 2


def setdefaultproxy(*args, **kwargs):
    return None


class socksocket:
    pass
