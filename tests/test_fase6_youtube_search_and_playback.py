"""Tests for Fase 6: YouTube search, video playback, and fullscreen from mobile."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from pydantic import ValidationError

from host.protocol import (
    CommandMessage,
    SearchMessage,
    SearchResultItem,
    SearchResultsMessage,
    parse_client_message,
    parse_server_message,
)
from host.providers.base import MasterVolumeInfo
from host.providers.chrome_extension import ChromeExtensionProvider
from host.state import HostStateCoordinator


class FakeExtensionTransport:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, data: Any) -> None:
        self.sent.append(data)


class FakeAudioProvider:
    async def get_master_volume(self) -> MasterVolumeInfo:
        return MasterVolumeInfo(level=0.5, muted=False, device_name="Alto-falantes")

    async def set_master_volume(
        self, level: float | None = None, muted: bool | None = None
    ) -> MasterVolumeInfo:
        return MasterVolumeInfo(
            level=level if level is not None else 0.5,
            muted=muted if muted is not None else False,
            device_name="Alto-falantes",
        )

    async def list_audio_apps(self) -> list[Any]:
        return []

    async def set_audio_app_volume(
        self, app_audio_id: str, level: float | None = None, muted: bool | None = None
    ) -> bool:
        return True

    async def send_media_key(self, action: str) -> bool:
        return True


def test_search_protocol_validation() -> None:
    # Valid search message
    msg = parse_client_message({"v": 1, "type": "search", "query": "synthwave music"})
    assert isinstance(msg, SearchMessage)
    assert msg.query == "synthwave music"

    # Truncates excessively long query (>120 chars)
    long_msg = parse_client_message({"v": 1, "type": "search", "query": "a" * 150})
    assert isinstance(long_msg, SearchMessage)
    assert len(long_msg.query) == 120

    # Rejects empty or whitespace query
    with pytest.raises(ValidationError):
        parse_client_message({"v": 1, "type": "search", "query": "   "})


def test_play_video_id_strict_validation() -> None:
    # Valid 11-char YouTube video ID
    cmd = parse_client_message(
        {
            "v": 1,
            "type": "command",
            "action": "play_video",
            "videoId": "dQw4w9WgXcQ",
            "mode": "current_tab",
            "fullscreen": True,
        }
    )
    assert isinstance(cmd, CommandMessage)
    assert cmd.videoId == "dQw4w9WgXcQ"
    assert cmd.mode == "current_tab"
    assert cmd.fullscreen is True

    # Rejects invalid videoId formats (path traversal, XSS, wrong length)
    invalid_ids = [
        "short",
        "toolongvideoid123",
        "https://youtube.com/watch?v=123",
        "../etc/pass",
        "dQw4w9WgXc;",
        "",
        "abc def 123",
    ]
    for bad_id in invalid_ids:
        with pytest.raises(ValidationError):
            parse_client_message(
                {
                    "v": 1,
                    "type": "command",
                    "action": "play_video",
                    "videoId": bad_id,
                }
            )


def test_search_results_protocol_serialization() -> None:
    res = SearchResultsMessage(
        requestId="req-1",
        ok=True,
        query="lofi",
        results=[
            SearchResultItem(
                id="jfKfPfyJRdk",
                title="Lofi Girl",
                channel="Lofi Girl",
                duration="",
                views="1.2M",
                thumbnail="https://i.ytimg.com/vi/jfKfPfyJRdk/hqdefault.jpg",
                isLive=True,
            )
        ],
    )
    raw = res.model_dump()
    parsed = parse_server_message(raw)
    assert isinstance(parsed, SearchResultsMessage)
    assert parsed.results[0].id == "jfKfPfyJRdk"
    assert parsed.results[0].isLive is True


@pytest.mark.anyio
async def test_chrome_extension_provider_search_and_playback() -> None:
    provider = ChromeExtensionProvider()
    transport = FakeExtensionTransport()
    provider.attach(transport)

    # 1. Test search_youtube flow
    search_task = asyncio.create_task(provider.search_youtube("test query"))
    await asyncio.sleep(0.01)

    assert len(transport.sent) == 1
    sent_search = transport.sent[0]
    assert sent_search["type"] == "search"
    assert sent_search["query"] == "test query"
    req_id = sent_search["requestId"]

    # Extension replies with search_results
    await provider.handle_message(
        {
            "type": "search_results",
            "requestId": req_id,
            "ok": True,
            "results": [
                {
                    "id": "11charId123",
                    "title": "Test Video",
                    "channel": "Channel",
                    "duration": "03:45",
                    "thumbnail": "https://i.ytimg.com/vi/11charId123/hqdefault.jpg",
                }
            ],
        }
    )

    ok, results, reason = await search_task
    assert ok is True
    assert len(results) == 1
    assert results[0]["id"] == "11charId123"

    # 2. Test play_video flow
    play_task = asyncio.create_task(
        provider.play_video(
            video_id="11charId123",
            mode="current_tab",
            fullscreen=True,
            session_id="chrome:42",
        )
    )
    await asyncio.sleep(0.01)

    assert len(transport.sent) == 2
    sent_play = transport.sent[1]
    assert sent_play["type"] == "play_video"
    assert sent_play["videoId"] == "11charId123"
    assert sent_play["mode"] == "current_tab"
    assert sent_play["fullscreen"] is True
    assert sent_play["tabId"] == "42"
    play_req_id = sent_play["requestId"]

    await provider.handle_message(
        {
            "type": "extension_ack",
            "requestId": play_req_id,
            "ok": True,
            "reason": "navigated_existing_tab",
        }
    )

    play_ok, play_reason = await play_task
    assert play_ok is True
    assert play_reason == "navigated_existing_tab"


@pytest.mark.anyio
async def test_coordinator_search_rate_limiting_and_offline_fallback() -> None:
    chrome = ChromeExtensionProvider()
    audio = FakeAudioProvider()
    coordinator = HostStateCoordinator(providers=[chrome], audio_provider=audio)

    # 1. When extension is disconnected, search returns fallbackUrl immediately
    offline_res = await coordinator.handle_raw_client_message(
        {"v": 1, "type": "search", "query": "synthwave radio", "requestId": "req-off"}
    )
    assert isinstance(offline_res, SearchResultsMessage)
    assert offline_res.ok is False
    assert "https://www.youtube.com/results?search_query=" in (offline_res.fallbackUrl or "")
    assert offline_res.reason == "extension_disconnected"

    # 2. Attach extension transport and test rate limiting
    coordinator._last_search_time = 0.0
    transport = FakeExtensionTransport()
    chrome.attach(transport)

    # First search succeeds
    async def mock_extension_worker() -> None:
        while True:
            await asyncio.sleep(0.01)
            for item in transport.sent:
                if item.get("type") == "search":
                    await chrome.handle_message(
                        {
                            "type": "search_results",
                            "requestId": item["requestId"],
                            "ok": True,
                            "results": [{"id": "dQw4w9WgXcQ", "title": "Never Gonna Give You Up"}],
                        }
                    )

    worker_task = asyncio.create_task(mock_extension_worker())
    try:
        # Rapid first search
        first_res = await coordinator.handle_raw_client_message(
            {"v": 1, "type": "search", "query": "rickroll", "requestId": "req-1"}
        )
        assert isinstance(first_res, SearchResultsMessage)
        assert first_res.ok is True
        assert len(first_res.results) == 1

        # Immediate second search is rate limited (within 1s)
        second_res = await coordinator.handle_raw_client_message(
            {"v": 1, "type": "search", "query": "rickroll 2", "requestId": "req-2"}
        )
        assert isinstance(second_res, SearchResultsMessage)
        assert second_res.ok is False
        assert second_res.reason == "rate_limited"
    finally:
        worker_task.cancel()


@pytest.mark.anyio
async def test_coordinator_toggle_fullscreen_and_play_video() -> None:
    chrome = ChromeExtensionProvider()
    transport = FakeExtensionTransport()
    chrome.attach(transport)
    audio = FakeAudioProvider()

    # Pre-populate session
    await chrome.handle_message(
        {
            "type": "extension_state",
            "tabs": [
                {
                    "tabId": 10,
                    "title": "YouTube Video",
                    "status": "PLAYING",
                    "isFullscreen": False,
                    "controls": {"play": False, "pause": True, "fullscreen": True},
                }
            ],
        }
    )

    coordinator = HostStateCoordinator(providers=[chrome], audio_provider=audio)

    # 1. Dispatch play_video
    async def reply_ack(req_id: str) -> None:
        await asyncio.sleep(0.01)
        await chrome.handle_message(
            {"type": "extension_ack", "requestId": req_id, "ok": True, "reason": "ok"}
        )

    async def auto_ack_worker() -> None:
        acked = set()
        while True:
            await asyncio.sleep(0.01)
            for item in list(transport.sent):
                req_id = item.get("requestId")
                if req_id and req_id not in acked:
                    acked.add(req_id)
                    asyncio.create_task(reply_ack(req_id))

    worker = asyncio.create_task(auto_ack_worker())
    try:
        play_ack = await coordinator.handle_raw_client_message(
            {
                "v": 1,
                "type": "command",
                "action": "play_video",
                "videoId": "dQw4w9WgXcQ",
                "mode": "current_tab",
                "fullscreen": True,
                "requestId": "play-cmd-1",
            }
        )
        assert play_ack is not None
        assert getattr(play_ack, "ok", False) is True

        # 2. Dispatch toggle_fullscreen
        fs_ack = await coordinator.handle_raw_client_message(
            {
                "v": 1,
                "type": "command",
                "action": "toggle_fullscreen",
                "sessionId": "chrome:10",
                "requestId": "fs-cmd-1",
            }
        )
        assert fs_ack is not None
        assert getattr(fs_ack, "ok", False) is True
    finally:
        worker.cancel()


@pytest.mark.anyio
async def test_chrome_extension_provider_trigger_fullscreen_key() -> None:
    chrome = ChromeExtensionProvider()
    transport = FakeExtensionTransport()
    chrome.attach(transport)

    async def reply_fullscreen_trigger(req_id: str) -> None:
        await asyncio.sleep(0.01)
        await chrome.handle_message(
            {
                "type": "extension_ack",
                "requestId": req_id,
                "ok": True,
                "reason": "trigger_fullscreen_key",
            }
        )

    async def worker_loop() -> None:
        while True:
            await asyncio.sleep(0.01)
            for item in list(transport.sent):
                req_id = item.get("requestId")
                if req_id:
                    asyncio.create_task(reply_fullscreen_trigger(req_id))
                    return

    worker = asyncio.create_task(worker_loop())
    try:
        ok, reason = await chrome.execute_command_with_reason(
            "chrome:42", "toggle_fullscreen", None
        )
        assert ok is True
        assert reason == "entered_fullscreen_via_key"
    finally:
        worker.cancel()

