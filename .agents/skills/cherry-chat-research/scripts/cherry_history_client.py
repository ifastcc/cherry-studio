#!/usr/bin/env python3
"""Minimal Cherry Studio history client built on the local /v1/history API."""

from __future__ import annotations

import json
import os
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
        self.base_url = (base_url or os.environ.get("CHERRY_API_BASE_URL", "")).rstrip("/")
        self.api_key = api_key or os.environ.get("CHERRY_API_KEY", "")
        self.timeout = timeout
        self.max_retries = max_retries

        if not self.base_url:
            raise ValueError("CHERRY_API_BASE_URL is required")
        if not self.api_key:
            raise ValueError("CHERRY_API_KEY is required")

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
            flat_params[key] = value
        return urllib.parse.urlencode(flat_params, doseq=True)
