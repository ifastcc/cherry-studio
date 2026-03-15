#!/usr/bin/env python3
"""Export a local research workspace from Cherry Studio history data."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import shutil
from pathlib import Path
from typing import Any, Dict, Iterable, List, Sequence

from cherry_history_client import CherryHistoryClient


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export a Cherry Studio chat-history research workspace")
    parser.add_argument("--output-dir", default="/tmp/cherry-chat-research-workspace")
    parser.add_argument("--topic-limit", type=int, default=20)
    parser.add_argument("--assistant-id")
    parser.add_argument("--keyword")
    parser.add_argument("--topic-id", action="append", dest="topic_ids")
    parser.add_argument("--search", action="append", dest="search_queries")
    parser.add_argument("--message-limit-per-page", type=int, default=200)
    parser.add_argument("--response-selection", choices=["all", "preferred"], default="all")
    parser.add_argument("--transcript-order", choices=["asc", "desc"], default="asc")
    return parser.parse_args()


def slugify(value: str, fallback: str) -> str:
    compact = value.strip().lower()
    compact = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "-", compact)
    compact = compact.strip("-")
    if not compact:
        compact = fallback
    return compact[:72]


def safe_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return str(value).strip()


def format_iso(value: str | None) -> str:
    if not value:
        return "N/A"
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return value
    return parsed.isoformat()


def make_workspace(output_dir: Path) -> None:
    if output_dir.exists():
        shutil.rmtree(output_dir)
    (output_dir / "topics").mkdir(parents=True, exist_ok=True)
    (output_dir / "searches").mkdir(parents=True, exist_ok=True)


def collect_topics(client: CherryHistoryClient, args: argparse.Namespace) -> List[Dict[str, Any]]:
    chosen: List[Dict[str, Any]] = []
    seen_topic_ids = set()

    if args.topic_ids:
        for topic_id in args.topic_ids:
            topic = client.get_topic(topic_id)
            if topic["topicId"] in seen_topic_ids:
                continue
            seen_topic_ids.add(topic["topicId"])
            chosen.append(topic)

    if chosen:
        return chosen

    catalog = client.list_topics(limit=args.topic_limit, assistantId=args.assistant_id, keyword=args.keyword)
    topics = catalog.get("topics", [])
    for topic in topics:
        if topic["topicId"] in seen_topic_ids:
            continue
        seen_topic_ids.add(topic["topicId"])
        chosen.append(topic)
    return chosen


def collect_transcript(
    client: CherryHistoryClient,
    topic_id: str,
    message_limit_per_page: int,
    response_selection: str,
    transcript_order: str,
) -> List[Dict[str, Any]]:
    return list(
        client.iter_transcript(
            topic_id,
            limitMessages=message_limit_per_page,
            responseSelection=response_selection,
            order=transcript_order,
        )
    )


def render_catalog_markdown(topics: Sequence[Dict[str, Any]]) -> str:
    lines = [
        "# Topic Catalog",
        "",
        "Use this file to decide where to read next. It is an index, not an interpretation.",
        "",
    ]
    if not topics:
        lines.append("- No topics matched the current filters.")
        return "\n".join(lines)

    for index, topic in enumerate(topics, start=1):
        lines.extend(
            [
                f"## {index}. {topic.get('topicName') or topic['topicId']}",
                f"- topicId: `{topic['topicId']}`",
                f"- assistant: {topic.get('assistantName') or 'N/A'}",
                f"- createdAt: {format_iso(topic.get('createdAt'))}",
                f"- lastMessageAt: {format_iso(topic.get('lastMessageAt'))}",
                f"- messageCount: {topic.get('messageCount', 'N/A')}",
                f"- roundCount: {topic.get('roundCount', 'N/A')}",
                f"- segmentCount: {topic.get('segmentCount', 'N/A')}",
                f"- preview: {safe_text(topic.get('preview')) or 'N/A'}",
                "",
            ]
        )
    return "\n".join(lines)


def render_message_markdown(message: Dict[str, Any], index: int) -> str:
    annotations = message.get("annotations") or {}
    lines = [
        f"### {index}. {message.get('role', 'unknown')} | {format_iso(message.get('createdAt'))}",
        f"- messageId: `{message.get('messageId', 'N/A')}`",
    ]
    if message.get("type"):
        lines.append(f"- type: `{message['type']}`")
    if annotations.get("segmentId"):
        lines.append(f"- segmentId: `{annotations['segmentId']}`")
    if annotations.get("roundId"):
        lines.append(f"- roundId: `{annotations['roundId']}`")
    if message.get("askId"):
        lines.append(f"- askId: `{message['askId']}`")
    if message.get("modelId"):
        lines.append(f"- modelId: `{message['modelId']}`")
    if annotations.get("isPreferredResponse") is True:
        lines.append("- preferredResponse: true")
    lines.append("")

    main_text = safe_text(message.get("mainText"))
    if main_text:
        lines.extend(["#### Main Text", "", main_text, ""])

    thinking_text = safe_text(message.get("thinkingText"))
    if thinking_text:
        lines.extend(["#### Thinking Text", "", thinking_text, ""])

    tool_calls = message.get("toolCalls") or []
    if tool_calls:
        lines.extend(["#### Tool Calls", ""])
        for tool_index, tool_call in enumerate(tool_calls, start=1):
            lines.append(f"- Tool {tool_index}: {tool_call.get('toolName') or 'Unknown'}")
            arguments = safe_text(tool_call.get("arguments"))
            result = safe_text(tool_call.get("result"))
            if arguments:
                lines.append("  - arguments:")
                lines.append("")
                lines.append("    ```json")
                for line in arguments.splitlines() or [""]:
                    lines.append(f"    {line}")
                lines.append("    ```")
            if result:
                lines.append("  - result:")
                lines.append("")
                lines.append("    ```text")
                for line in result.splitlines() or [""]:
                    lines.append(f"    {line}")
                lines.append("    ```")
        lines.append("")

    if not main_text and not thinking_text and not tool_calls:
        lines.extend(["#### Content", "", "_No textual content extracted for this message._", ""])

    return "\n".join(lines)


def render_topic_markdown(topic: Dict[str, Any], transcript: Sequence[Dict[str, Any]]) -> str:
    lines = [
        f"# {topic.get('topicName') or topic['topicId']}",
        "",
        "This file is raw research material exported from the local /v1/history API. Read it directly; do not assume it already contains conclusions.",
        "",
        f"- topicId: `{topic['topicId']}`",
        f"- assistant: {topic.get('assistantName') or 'N/A'}",
        f"- createdAt: {format_iso(topic.get('createdAt'))}",
        f"- updatedAt: {format_iso(topic.get('updatedAt'))}",
        f"- firstMessageAt: {format_iso(topic.get('firstMessageAt'))}",
        f"- lastMessageAt: {format_iso(topic.get('lastMessageAt'))}",
        f"- messageCount: {topic.get('messageCount', 'N/A')}",
        f"- roundCount: {topic.get('roundCount', 'N/A')}",
        f"- segmentCount: {topic.get('segmentCount', 'N/A')}",
        "",
        "## Transcript",
        "",
    ]

    if not transcript:
        lines.append("_No transcript messages were returned for this topic._")
        return "\n".join(lines)

    for index, message in enumerate(transcript, start=1):
        lines.append(render_message_markdown(message, index))

    return "\n".join(lines)


def render_search_markdown(query: str, payload: Dict[str, Any]) -> str:
    hits = payload.get("hits", [])
    lines = [
        f"# Search: {query}",
        "",
        "Use these hits as entry points. Search results are not conclusions.",
        "",
        f"- total: {payload.get('total', len(hits))}",
        "",
    ]
    if not hits:
        lines.append("- No hits were returned.")
        return "\n".join(lines)

    for index, hit in enumerate(hits, start=1):
        annotations = hit.get("annotations") or {}
        lines.extend(
            [
                f"## Hit {index}",
                f"- topic: {hit.get('topicName') or hit.get('topicId')}",
                f"- topicId: `{hit.get('topicId', 'N/A')}`",
                f"- role: `{hit.get('role', 'N/A')}`",
                f"- createdAt: {format_iso(hit.get('createdAt'))}",
                f"- messageId: `{hit.get('messageId', 'N/A')}`",
                f"- segmentId: `{annotations.get('segmentId', 'N/A')}`",
                f"- roundId: `{annotations.get('roundId', 'N/A')}`",
                "",
                hit.get("snippet") or "_No snippet returned._",
                "",
            ]
        )

    return "\n".join(lines)


def render_workspace_readme(
    output_dir: Path,
    topics: Sequence[Dict[str, Any]],
    search_queries: Sequence[str],
) -> str:
    lines = [
        "# Cherry Chat Research Workspace",
        "",
        "This workspace is raw material for deep chat-history research.",
        "It does not contain precomputed themes, personality claims, or fixed conclusions.",
        "",
        "## Suggested Use",
        "",
        "1. Start with `catalog.md` to see the available topics.",
        "2. Read the topic transcripts that feel recent, emotionally charged, or repeatedly relevant.",
        "3. Use the `searches/` folder for motif tracing when you already suspect a theme.",
        "4. Form hypotheses, look for counterexamples, and only then write the final report or HTML artifact.",
        "",
        "## Files",
        "",
        "- `manifest.json`: export metadata and file index",
        "- `catalog.json`: raw topic catalog payload",
        "- `catalog.md`: human-readable topic index",
        "- `topics/*.json`: per-topic raw transcript bundles",
        "- `topics/*.md`: per-topic readable transcripts",
        "- `searches/*.json` and `searches/*.md`: optional search results",
        "",
        f"- outputDir: `{output_dir}`",
        f"- topicsExported: {len(topics)}",
        f"- searchesExported: {len(search_queries)}",
    ]
    return "\n".join(lines)


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def write_text(path: Path, value: str) -> None:
    path.write_text(value, encoding="utf-8")


def topic_payload(topic: Dict[str, Any], transcript: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        "topic": topic,
        "transcript": list(transcript),
    }


def export_topics(
    output_dir: Path,
    topics: Sequence[Dict[str, Any]],
    client: CherryHistoryClient,
    args: argparse.Namespace,
) -> List[Dict[str, Any]]:
    topic_entries: List[Dict[str, Any]] = []
    for topic in topics:
        topic_meta = client.get_topic(topic["topicId"])
        transcript = collect_transcript(
            client,
            topic_meta["topicId"],
            message_limit_per_page=args.message_limit_per_page,
            response_selection=args.response_selection,
            transcript_order=args.transcript_order,
        )
        base_name = slugify(topic_meta.get("topicName") or topic_meta["topicId"], topic_meta["topicId"])
        json_name = f"{base_name}__{topic_meta['topicId']}.json"
        md_name = f"{base_name}__{topic_meta['topicId']}.md"
        json_path = output_dir / "topics" / json_name
        md_path = output_dir / "topics" / md_name
        write_json(json_path, topic_payload(topic_meta, transcript))
        write_text(md_path, render_topic_markdown(topic_meta, transcript))
        topic_entries.append(
            {
                "topicId": topic_meta["topicId"],
                "topicName": topic_meta.get("topicName") or topic_meta["topicId"],
                "jsonFile": f"topics/{json_name}",
                "markdownFile": f"topics/{md_name}",
                "messageCount": len(transcript),
            }
        )
    return topic_entries


def export_searches(output_dir: Path, client: CherryHistoryClient, queries: Sequence[str]) -> List[Dict[str, Any]]:
    search_entries: List[Dict[str, Any]] = []
    for query in queries:
        payload = client.search_messages(query, limit=50)
        base_name = slugify(query, "search")
        json_name = f"{base_name}.json"
        md_name = f"{base_name}.md"
        json_path = output_dir / "searches" / json_name
        md_path = output_dir / "searches" / md_name
        write_json(json_path, payload)
        write_text(md_path, render_search_markdown(query, payload))
        search_entries.append(
            {
                "query": query,
                "jsonFile": f"searches/{json_name}",
                "markdownFile": f"searches/{md_name}",
                "hitCount": payload.get("total", len(payload.get("hits", []))),
            }
        )
    return search_entries


def build_manifest(
    output_dir: Path,
    args: argparse.Namespace,
    topic_entries: Sequence[Dict[str, Any]],
    search_entries: Sequence[Dict[str, Any]],
) -> Dict[str, Any]:
    return {
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "workspacePurpose": "Raw material for deep chat-history research. This workspace intentionally avoids precomputed interpretations.",
        "outputDir": str(output_dir),
        "filters": {
            "topicLimit": args.topic_limit,
            "assistantId": args.assistant_id,
            "keyword": args.keyword,
            "topicIds": args.topic_ids or [],
            "searchQueries": args.search_queries or [],
            "messageLimitPerPage": args.message_limit_per_page,
            "responseSelection": args.response_selection,
            "transcriptOrder": args.transcript_order,
        },
        "topics": list(topic_entries),
        "searches": list(search_entries),
    }


def main() -> None:
    args = parse_args()
    client = CherryHistoryClient()
    output_dir = Path(args.output_dir).expanduser().resolve()
    make_workspace(output_dir)

    topics = collect_topics(client, args)
    catalog_payload = {"topics": list(topics), "total": len(topics)}
    write_json(output_dir / "catalog.json", catalog_payload)
    write_text(output_dir / "catalog.md", render_catalog_markdown(topics))

    topic_entries = export_topics(output_dir, topics, client, args)
    search_entries = export_searches(output_dir, client, args.search_queries or [])

    manifest = build_manifest(output_dir, args, topic_entries, search_entries)
    write_json(output_dir / "manifest.json", manifest)
    write_text(output_dir / "README.md", render_workspace_readme(output_dir, topics, args.search_queries or []))

    print(str(output_dir))


if __name__ == "__main__":
    main()
