#!/usr/bin/env python3
"""Minimal Cherry Studio history client built on the local /v1/history API."""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Iterable, Optional


class CherryHistoryClient:
    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        timeout: float = 30.0,
        max_retries: int = 2,
    ) -> None:
        explicit_base_url = (base_url or os.environ.get("CHERRY_API_BASE_URL", "")).rstrip("/")
        explicit_api_key = api_key or os.environ.get("CHERRY_API_KEY", "")
        discovered = self._load_connection_profile()
        self.base_url = (explicit_base_url or discovered.get("baseURL") or "http://127.0.0.1:23333/v1").rstrip("/")
        self.api_key = explicit_api_key or discovered.get("apiKey", "")
        self.timeout = timeout
        self.max_retries = max_retries

        if not self.base_url:
            raise ValueError("CHERRY_API_BASE_URL is required")
        if not self.api_key:
            raise ValueError("CHERRY_API_KEY is required or Cherry connection profile could not be discovered")

    def _request(self, path: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        query = self._encode_query(params or {})
        url = f"{self.base_url}{path}"
        if query:
            url = f"{url}?{query}"

        headers = {
            "Accept": "application/json",
            "X-API-Key": self.api_key,
        }

        request = urllib.request.Request(url, headers=headers, method="GET")

        for attempt in range(self.max_retries + 1):
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    return json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as error:
                body = error.read().decode("utf-8", errors="replace")
                message = body
                try:
                    payload = json.loads(body)
                    message = payload.get("error", {}).get("message", body)
                except json.JSONDecodeError:
                    pass
                if error.code >= 500 and attempt < self.max_retries:
                    time.sleep(0.5 * (attempt + 1))
                    continue
                raise RuntimeError(f"HTTP {error.code} for {url}: {message}") from error
            except urllib.error.URLError as error:
                if attempt < self.max_retries:
                    time.sleep(0.5 * (attempt + 1))
                    continue
                raise RuntimeError(f"Failed to reach {url}: {error}") from error

        raise RuntimeError(f"Failed to request {url}")

    def list_topics(self, **params: Any) -> Dict[str, Any]:
        return self._request("/history/topics", params)

    def get_topic(self, topic_id: str) -> Dict[str, Any]:
        return self._request(f"/history/topics/{urllib.parse.quote(topic_id, safe='')}")

    def list_messages(self, topic_id: str, **params: Any) -> Dict[str, Any]:
        return self._request(f"/history/topics/{urllib.parse.quote(topic_id, safe='')}/messages", params)

    def get_message(self, message_id: str) -> Dict[str, Any]:
        return self._request(f"/history/messages/{urllib.parse.quote(message_id, safe='')}")

    def get_transcript_page(self, topic_id: str, **params: Any) -> Dict[str, Any]:
        return self._request(f"/history/topics/{urllib.parse.quote(topic_id, safe='')}/transcript", params)

    def iter_transcript(self, topic_id: str, **params: Any) -> Iterable[Dict[str, Any]]:
        cursor: Optional[str] = None
        while True:
            page_params = dict(params)
            if cursor:
                page_params["cursor"] = cursor
            page = self.get_transcript_page(topic_id, **page_params)
            for message in page.get("messages", []):
                yield message
            page_info = page.get("pageInfo", {})
            if not page_info.get("hasMore"):
                break
            cursor = page_info.get("nextCursor")
            if not cursor:
                break

    def search_messages(self, query: str, **params: Any) -> Dict[str, Any]:
        payload = dict(params)
        payload["q"] = query
        return self._request("/history/search/messages", payload)

    @staticmethod
    def _encode_query(params: Dict[str, Any]) -> str:
        flat_params: Dict[str, Any] = {}
        for key, value in params.items():
            if value is None:
                continue
            if isinstance(value, bool):
                flat_params[key] = "true" if value else "false"
                continue
            if isinstance(value, dict):
                flat_params[key] = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
                continue
            flat_params[key] = value
        return urllib.parse.urlencode(flat_params, doseq=True)

    @classmethod
    def _load_connection_profile(cls) -> Dict[str, str]:
        for path in cls._candidate_connection_files():
            try:
                with open(path, "r", encoding="utf-8") as handle:
                    payload = json.load(handle)
            except (FileNotFoundError, json.JSONDecodeError, OSError):
                continue

            if not isinstance(payload, dict):
                continue

            base_url = payload.get("baseURL")
            api_key = payload.get("apiKey")
            result: Dict[str, str] = {}
            if isinstance(base_url, str) and base_url.strip():
                result["baseURL"] = base_url.strip()
            if isinstance(api_key, str) and api_key.strip():
                result["apiKey"] = api_key.strip()
            if result:
                return result

        return {}

    @staticmethod
    def _candidate_connection_files() -> Iterable[str]:
        explicit = os.environ.get("CHERRY_API_CONNECTION_FILE")
        if explicit:
            yield os.path.expanduser(explicit)

        home = os.path.expanduser("~")
        app_names = ("CherryStudio", "CherryStudioDev")

        if sys.platform == "darwin":
            base_dir = os.path.join(home, "Library", "Application Support")
            for app_name in app_names:
                yield os.path.join(base_dir, app_name, "Data", "api-server.json")
            return

        if os.name == "nt":
            base_dir = os.environ.get("APPDATA")
            if base_dir:
                for app_name in app_names:
                    yield os.path.join(base_dir, app_name, "Data", "api-server.json")
            return

        xdg_config_home = os.environ.get("XDG_CONFIG_HOME", os.path.join(home, ".config"))
        for app_name in app_names:
            yield os.path.join(xdg_config_home, app_name, "Data", "api-server.json")
