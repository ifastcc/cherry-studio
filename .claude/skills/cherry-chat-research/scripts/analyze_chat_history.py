#!/usr/bin/env python3
"""Generate a Markdown research report from Cherry Studio chat history."""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import math
import os
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Sequence, Tuple

from cherry_history_client import CherryHistoryClient


STOPWORDS = {
    "the",
    "and",
    "for",
    "that",
    "this",
    "with",
    "from",
    "have",
    "will",
    "would",
    "there",
    "what",
    "about",
    "please",
    "帮我",
    "这个",
    "那个",
    "就是",
    "可以",
    "一下",
    "因为",
    "所以",
    "然后",
    "如果",
    "已经",
    "还是",
    "没有",
    "自己",
    "觉得",
    "问题",
    "怎么",
    "如何",
}

HEDGE_TERMS = {"可能", "也许", "似乎", "大概", "maybe", "perhaps", "probably", "might", "seems"}
CERTAINTY_TERMS = {"必须", "一定", "显然", "肯定", "definitely", "must", "clearly", "certainly"}
CAUSAL_TERMS = {"因为", "所以", "导致", "因此", "because", "therefore", "cause", "result"}
PLANNING_TERMS = {"先", "再", "之后", "长期", "短期", "计划", "later", "next", "plan", "roadmap"}
COMPARISON_TERMS = {"更", "相比", "取舍", "利弊", "better", "worse", "tradeoff", "compare"}
EMOTION_TERMS = {
    "anxiety": {"焦虑", "紧张", "担心", "stress", "worried", "anxious"},
    "frustration": {"烦", "难受", "崩溃", "frustrated", "annoyed"},
    "positive": {"开心", "满意", "兴奋", "happy", "glad", "excited"},
}
VALUE_TERMS = {
    "efficiency": {"效率", "省时", "高效", "efficient", "speed"},
    "control": {"控制", "掌控", "可控", "control", "stable"},
    "growth": {"成长", "学习", "提升", "growth", "learn", "improve"},
    "freedom": {"自由", "灵活", "free", "flexible"},
    "responsibility": {"责任", "负责", "responsibility", "ownership"},
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Analyze Cherry Studio chat history")
    parser.add_argument("--topic-limit", type=int, default=20)
    parser.add_argument("--assistant-id")
    parser.add_argument("--keyword")
    parser.add_argument("--message-limit-per-page", type=int, default=200)
    parser.add_argument("--output")
    return parser.parse_args()


def tokenize(text: str) -> List[str]:
    english = re.findall(r"[A-Za-z]{2,}", text.lower())
    chinese_chunks = re.findall(r"[\u4e00-\u9fff]{2,}", text)
    chinese = []
    for chunk in chinese_chunks:
        if len(chunk) <= 3:
            chinese.append(chunk)
            continue
        chinese.extend(chunk[index : index + 2] for index in range(len(chunk) - 1))
    tokens = [token for token in english + chinese if token not in STOPWORDS and not token.isdigit()]
    return tokens


def count_terms(tokens: Sequence[str], terms: Sequence[str] | set[str]) -> int:
    term_set = set(terms)
    return sum(1 for token in tokens if token in term_set)


def classify_question(text: str) -> str:
    lowered = text.lower()
    if any(marker in lowered for marker in ["write", "draft", "润色", "写", "改写", "总结"]):
        return "creation"
    if any(marker in lowered for marker in ["should", "choose", "选", "决策", "利弊", "tradeoff"]):
        return "decision"
    return "search"


def iso_to_datetime(value: str) -> dt.datetime:
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


@dataclass
class TopicCorpus:
    topic: Dict[str, Any]
    messages: List[Dict[str, Any]]


def collect_topic_corpora(client: CherryHistoryClient, args: argparse.Namespace) -> List[TopicCorpus]:
    catalog = client.list_topics(limit=args.topic_limit, assistantId=args.assistant_id, keyword=args.keyword)
    topics = catalog.get("topics", [])
    corpora: List[TopicCorpus] = []
    for topic in topics:
        transcript = list(
            client.iter_transcript(
                topic["topicId"],
                limitMessages=args.message_limit_per_page,
                responseSelection="all",
                order="asc",
            )
        )
        corpora.append(TopicCorpus(topic=topic, messages=transcript))
    return corpora


def compute_tfidf(topics: Sequence[TopicCorpus]) -> List[Tuple[str, float]]:
    doc_tokens: List[List[str]] = []
    document_frequency: collections.Counter[str] = collections.Counter()
    for corpus in topics:
        tokens = tokenize(" ".join(message.get("mainText") or "" for message in corpus.messages))
        doc_tokens.append(tokens)
        for token in set(tokens):
            document_frequency[token] += 1

    scores: collections.Counter[str] = collections.Counter()
    doc_count = max(len(doc_tokens), 1)
    for tokens in doc_tokens:
        term_frequency = collections.Counter(tokens)
        token_total = max(len(tokens), 1)
        for token, count in term_frequency.items():
            tf = count / token_total
            idf = math.log((doc_count + 1) / (document_frequency[token] + 1)) + 1
            scores[token] += tf * idf

    return scores.most_common(20)


def compute_cooccurrence(topics: Sequence[TopicCorpus]) -> List[Tuple[Tuple[str, str], int]]:
    edge_weights: collections.Counter[Tuple[str, str]] = collections.Counter()
    for corpus in topics:
        tokens = tokenize(" ".join(message.get("mainText") or "" for message in corpus.messages))
        unique_tokens = list(dict.fromkeys(tokens[:40]))
        for index, left in enumerate(unique_tokens):
            for right in unique_tokens[index + 1 :]:
                pair = tuple(sorted((left, right)))
                edge_weights[pair] += 1
    return edge_weights.most_common(10)


def describe_behavior(topics: Sequence[TopicCorpus]) -> Dict[str, Any]:
    clear_count = 0
    user_messages = 0
    assistant_messages = 0
    active_hours: collections.Counter[int] = collections.Counter()
    question_types: collections.Counter[str] = collections.Counter()
    segment_ids = set()
    round_ids = set()
    round_gaps: List[float] = []

    for corpus in topics:
        clear_count += max(int(corpus.topic.get("segmentCount", 0)) - 1, 0)
        user_timestamps: List[dt.datetime] = []

        for message in corpus.messages:
            annotations = message.get("annotations", {})
            if annotations.get("segmentId"):
                segment_ids.add((corpus.topic["topicId"], annotations["segmentId"]))
            if annotations.get("roundId"):
                round_ids.add((corpus.topic["topicId"], annotations["roundId"]))

            timestamp = iso_to_datetime(message["createdAt"])
            active_hours[timestamp.hour] += 1

            if message["role"] == "user":
                user_messages += 1
                user_timestamps.append(timestamp)
                question_types[classify_question(message.get("mainText") or "")] += 1
            else:
                assistant_messages += 1

        for index in range(1, len(user_timestamps)):
            gap_hours = (user_timestamps[index] - user_timestamps[index - 1]).total_seconds() / 3600
            round_gaps.append(gap_hours)

    return {
        "topicCount": len(topics),
        "segmentCount": len(segment_ids),
        "roundCount": len(round_ids),
        "userMessages": user_messages,
        "assistantMessages": assistant_messages,
        "activeHours": active_hours.most_common(5),
        "questionTypes": question_types,
        "avgRoundGapHours": (sum(round_gaps) / len(round_gaps)) if round_gaps else None,
        "clearCount": clear_count,
    }


def describe_style(topics: Sequence[TopicCorpus]) -> Dict[str, Any]:
    tokens = tokenize(" ".join(message.get("mainText") or "" for corpus in topics for message in corpus.messages))
    return {
        "hedgeCount": count_terms(tokens, HEDGE_TERMS),
        "certaintyCount": count_terms(tokens, CERTAINTY_TERMS),
        "causalCount": count_terms(tokens, CAUSAL_TERMS),
        "planningCount": count_terms(tokens, PLANNING_TERMS),
        "comparisonCount": count_terms(tokens, COMPARISON_TERMS),
        "tokenCount": len(tokens),
        "uniqueTokenCount": len(set(tokens)),
    }


def describe_emotion_and_values(topics: Sequence[TopicCorpus]) -> Dict[str, Dict[str, int]]:
    tokens = tokenize(" ".join(message.get("mainText") or "" for corpus in topics for message in corpus.messages))
    emotions = {label: count_terms(tokens, terms) for label, terms in EMOTION_TERMS.items()}
    values = {label: count_terms(tokens, terms) for label, terms in VALUE_TERMS.items()}
    return {"emotions": emotions, "values": values}


def build_interest_timeline(topics: Sequence[TopicCorpus]) -> List[Tuple[str, List[str]]]:
    window_scores: Dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    for corpus in topics:
        for message in corpus.messages:
            if message["role"] != "user":
                continue
            window = message["createdAt"][:10]
            for token in tokenize(message.get("mainText") or ""):
                window_scores[window][token] += 1
    return [(window, [token for token, _ in scores.most_common(5)]) for window, scores in sorted(window_scores.items())]


def render_report(topics: Sequence[TopicCorpus]) -> str:
    behavior = describe_behavior(topics)
    style = describe_style(topics)
    emotion_values = describe_emotion_and_values(topics)
    tfidf_terms = compute_tfidf(topics)
    cooccurrence = compute_cooccurrence(topics)
    timeline = build_interest_timeline(topics)

    summary_lines = [
        f"- Topics analyzed: {behavior['topicCount']}",
        f"- Segments observed: {behavior['segmentCount']}",
        f"- Rounds observed: {behavior['roundCount']}",
        f"- User messages: {behavior['userMessages']}",
        f"- Assistant messages: {behavior['assistantMessages']}",
    ]

    summary_lines.append(f"- Clear boundaries inferred: {behavior['clearCount']}")

    if behavior["avgRoundGapHours"] is not None:
        summary_lines.append(f"- Average gap between user rounds: {behavior['avgRoundGapHours']:.1f} hours")

    question_mix = ", ".join(f"{name}={count}" for name, count in behavior["questionTypes"].most_common())
    active_hours = ", ".join(f"{hour}:00 ({count})" for hour, count in behavior["activeHours"])
    top_terms = ", ".join(f"{term} ({score:.2f})" for term, score in tfidf_terms[:10])
    top_edges = ", ".join(f"{left}-{right} ({weight})" for (left, right), weight in cooccurrence[:8])
    timeline_lines = "\n".join(f"- {window}: {', '.join(words)}" for window, words in timeline[:10]) or "- No timeline data"

    emotion_lines = "\n".join(
        f"- {label}: {count}" for label, count in sorted(emotion_values["emotions"].items(), key=lambda item: item[1], reverse=True)
    )
    value_lines = "\n".join(
        f"- {label}: {count}" for label, count in sorted(emotion_values["values"].items(), key=lambda item: item[1], reverse=True)
    )

    return f"""# Executive Summary

{os.linesep.join(summary_lines)}

# Topic & Interest Evolution

- High-salience terms (TF-IDF style): {top_terms or 'N/A'}
- Concept co-occurrence edges: {top_edges or 'N/A'}
- Topic timeline:
{timeline_lines}

# Conversation Behavior

- Question mix: {question_mix or 'N/A'}
- Peak active hours: {active_hours or 'N/A'}
- Preferred response behavior is inferred from `message.annotations.isPreferredResponse` where available.

# Style & Cognitive Cues

- Hedge language count: {style['hedgeCount']}
- Certainty language count: {style['certaintyCount']}
- Causal language count: {style['causalCount']}
- Planning language count: {style['planningCount']}
- Comparison / tradeoff language count: {style['comparisonCount']}
- Token diversity: {style['uniqueTokenCount']} unique terms across {style['tokenCount']} tokens

# Emotional / Value Signals

Emotion cues:
{emotion_lines}

Value cues:
{value_lines}

# Limits & Uncertainty

- This report summarizes language patterns in the available Cherry Studio chat history only.
- Tokenization is heuristic, especially for Chinese text, so topic and concept terms are approximate.
- The report should be read as descriptive evidence about chat behavior, not as diagnosis or personality typing.
- Missing topics, missing transcripts, or filtered segments can materially change the conclusions.
"""


def main() -> None:
    args = parse_args()
    client = CherryHistoryClient()
    corpora = collect_topic_corpora(client, args)
    report = render_report(corpora)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as output_file:
            output_file.write(report)
            if not report.endswith("\n"):
                output_file.write("\n")
    else:
        print(report)


if __name__ == "__main__":
    main()
