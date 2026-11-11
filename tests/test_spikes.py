"""Unit tests for Fase 0 spike helper functions (no live OS audio/media side effects)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from scripts.spike_media import (
    SessionControlsInfo,
    SessionSnapshot,
    estimate_position_seconds,
    format_seconds,
    parse_time_argument,
    resolve_session_index,
    seconds_to_100ns_ticks,
)
from scripts.spike_network import NetworkInterfaceInfo, get_primary_lan_ip
from scripts.spike_volume import (
    AudioSessionSnapshot,
    parse_mute_flag,
    parse_volume_level,
    resolve_session_indices,
)


def _make_media_snapshot(
    index: int,
    app_id: str,
    title: str,
    is_current: bool = False,
) -> SessionSnapshot:
    return SessionSnapshot(
        index=index,
        is_current=is_current,
        app_id=app_id,
        title=title,
        artist="Artist",
        album="",
        subtitle="",
        playback_type="MUSIC",
        status="PLAYING" if is_current else "PAUSED",
        position_sec=10.0,
        estimated_position_sec=10.0,
        start_sec=0.0,
        duration_sec=120.0,
        min_seek_sec=0.0,
        max_seek_sec=120.0,
        last_updated_utc=None,
        controls=SessionControlsInfo(
            play=True,
            pause=True,
            toggle=True,
            next=True,
            previous=True,
            seek=True,
        ),
    )


def _make_audio_snapshot(
    index: int, process_name: str, display_name: str = ""
) -> AudioSessionSnapshot:
    return AudioSessionSnapshot(
        index=index,
        pid=1000 + index,
        process_name=process_name,
        display_name=display_name,
        state_code=1,
        state="Active",
        volume=1.0,
        muted=False,
        grouping_param="{00000000-0000-0000-0000-000000000000}",
        identifier="id",
        instance_identifier="inst",
    )


def test_format_seconds() -> None:
    assert format_seconds(0) == "00:00"
    assert format_seconds(65.4) == "01:05"
    assert format_seconds(3661) == "1:01:01"
    assert format_seconds(-5) == "00:00"


def test_parse_time_argument() -> None:
    assert parse_time_argument("42.5") == 42.5
    assert parse_time_argument("01:30") == 90.0
    assert parse_time_argument("1:02:03") == 3723.0
    with pytest.raises(ValueError):
        parse_time_argument("-1")
    with pytest.raises(ValueError):
        parse_time_argument("1:2:3:4")


def test_seconds_to_100ns_ticks() -> None:
    assert seconds_to_100ns_ticks(0.0) == 0
    assert seconds_to_100ns_ticks(30.0) == 300_000_000
    with pytest.raises(ValueError):
        seconds_to_100ns_ticks(-0.1)


def test_estimate_position_seconds() -> None:
    updated = datetime(2026, 11, 11, 12, 0, 0, tzinfo=UTC)
    now = datetime(2026, 11, 11, 12, 0, 10, tzinfo=UTC)

    # Playing session advances from last_updated and clamps at end_time
    assert (
        estimate_position_seconds(
            timedelta(seconds=20),
            timedelta(seconds=100),
            updated,
            "PLAYING",
            now_utc=now,
        )
        == 30.0
    )
    assert (
        estimate_position_seconds(
            timedelta(seconds=95),
            timedelta(seconds=100),
            updated,
            "PLAYING",
            now_utc=now,
        )
        == 100.0
    )
    # Paused session does not extrapolate elapsed time
    assert (
        estimate_position_seconds(
            timedelta(seconds=20),
            timedelta(seconds=100),
            updated,
            "PAUSED",
            now_utc=now,
        )
        == 20.0
    )


def test_resolve_media_session_index() -> None:
    snaps = [
        _make_media_snapshot(0, "Spotify.exe", "Song A", is_current=False),
        _make_media_snapshot(1, "chrome.exe", "Video B", is_current=True),
    ]
    assert resolve_session_index(snaps, None) == 1
    assert resolve_session_index(snaps, "0") == 0
    assert resolve_session_index(snaps, "spotify") == 0
    assert resolve_session_index(snaps, "video b") == 1
    with pytest.raises(ValueError):
        resolve_session_index(snaps, "9")
    with pytest.raises(ValueError):
        resolve_session_index(snaps, "vlc")


def test_volume_parsing_and_session_resolution() -> None:
    assert parse_volume_level("0.5") == 0.5
    assert parse_volume_level("75%") == 0.75
    with pytest.raises(ValueError):
        parse_volume_level("1.5")
    with pytest.raises(ValueError):
        parse_volume_level("110%")

    assert parse_mute_flag("on") is True
    assert parse_mute_flag("off") is False
    assert parse_mute_flag("toggle") is None
    with pytest.raises(ValueError):
        parse_mute_flag("maybe")

    snaps = [
        _make_audio_snapshot(0, "chrome.exe"),
        _make_audio_snapshot(1, "Spotify.exe", "Spotify"),
        _make_audio_snapshot(2, "chrome.exe"),
    ]
    assert resolve_session_indices(snaps, "1") == [1]
    assert resolve_session_indices(snaps, "chrome", all_matches=False) == [0]
    assert resolve_session_indices(snaps, "chrome", all_matches=True) == [0, 2]
    with pytest.raises(ValueError):
        resolve_session_indices(snaps, "vlc")


def test_get_primary_lan_ip_skips_virtual_adapters(monkeypatch: pytest.MonkeyPatch) -> None:
    import socket

    class _FailingSocket:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        def __enter__(self) -> _FailingSocket:
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def connect(self, _addr: object) -> None:
            raise OSError("network unreachable")

    monkeypatch.setattr(socket, "socket", _FailingSocket)
    interfaces = [
        NetworkInterfaceInfo("Hyper-V Virtual Ethernet Adapter", "172.22.96.1", 20),
        NetworkInterfaceInfo("Qualcomm Atheros Wi-Fi", "192.168.1.42", 24),
    ]
    assert get_primary_lan_ip(interfaces) == "192.168.1.42"
