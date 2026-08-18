"""Test double for the nova3 `helpers` module.

Only what the shim and the fixture engines call. `enable_socks_proxy` reads the
same `qbt_socks_proxy` variable upstream does so the env-scrubbing test has
something real to assert against.
"""

import os
import urllib.request

LAST_SOCKS_URL = None


def enable_socks_proxy(enable):
    global LAST_SOCKS_URL
    LAST_SOCKS_URL = os.environ.get("qbt_socks_proxy") if enable else None  # noqa: SIM112


def retrieve_url(url, *args, **kwargs):
    with urllib.request.urlopen(url) as response:
        return response.read().decode("utf-8", "replace")


def download_file(url, referer=None, ssl_context=None):
    import tempfile

    handle, path = tempfile.mkstemp()
    with os.fdopen(handle, "wb") as file, urllib.request.urlopen(url) as response:
        file.write(response.read())
    return f"{path} {url}"
