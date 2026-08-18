"""Settings, and the one piece of state the process keeps between runs.

The API key is the only thing a caller has to hold on to, so it has to survive
a restart — start.sh, stop.sh and update.sh are only usable if it does.
"""

from __future__ import annotations

import os
import stat

import pytest

from utsi.config import Settings, load_or_create_key


def test_generates_a_key_and_keeps_it(tmp_path):
    path = tmp_path / "nested" / "api-key"
    first = load_or_create_key(path)

    assert len(first) >= 32
    assert load_or_create_key(path) == first, "a restart must not change the key"
    assert path.read_text(encoding="utf-8").strip() == first


def test_the_key_file_is_not_readable_by_anyone_else(tmp_path):
    path = tmp_path / "api-key"
    load_or_create_key(path)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_a_blank_file_is_treated_as_no_key(tmp_path):
    path = tmp_path / "api-key"
    path.write_text("\n", encoding="utf-8")
    assert load_or_create_key(path) != ""


@pytest.mark.skipif(os.geteuid() == 0, reason="root writes into unwritable directories")
def test_an_unwritable_location_still_yields_a_working_key(tmp_path):
    """A read-only image should run, just without the key surviving a restart."""
    directory = tmp_path / "ro"
    directory.mkdir()
    directory.chmod(0o500)
    try:
        key = load_or_create_key(directory / "api-key")
    finally:
        directory.chmod(0o700)
    assert len(key) >= 32


def test_key_file_env_var_is_honoured(tmp_path, monkeypatch):
    path = tmp_path / "key"
    monkeypatch.setenv("UTSI_KEY_FILE", str(path))
    monkeypatch.delenv("UTSI_API_KEY", raising=False)

    settings = Settings.from_env()

    assert settings.api_key == path.read_text(encoding="utf-8").strip()


def test_an_explicit_key_wins_and_writes_nothing(tmp_path, monkeypatch):
    path = tmp_path / "key"
    monkeypatch.setenv("UTSI_KEY_FILE", str(path))
    monkeypatch.setenv("UTSI_API_KEY", "chosen-by-hand")

    assert Settings.from_env().api_key == "chosen-by-hand"
    assert not path.exists()
