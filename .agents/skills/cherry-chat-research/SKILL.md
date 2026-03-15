---
name: cherry-chat-research
description: Research Cherry Studio chat history through the local /v1/history API. Use when the user wants topic catalogs, transcript-driven analysis, behavioral summaries, interest evolution, or a Markdown report about one person's chat history.
---

# Cherry Chat Research

This skill studies Cherry Studio chat history through the local history API.
It relies on the local API server and repo-local Python scripts that can be mirrored into compatible skill runtimes.

## Inputs

Set these environment variables before running the scripts:

- `CHERRY_API_BASE_URL=http://127.0.0.1:<port>/v1`
- `CHERRY_API_KEY=<api key>`

## Data Semantics

- `clear` messages are context boundaries, not normal content.
- A `segment` is the continuous message span after a `clear` boundary.
- A `round` is one user message plus assistant messages whose `askId` matches that user message id.
- `message.annotations.segmentId` and `message.annotations.roundId` are the primary structural anchors.
- `message.annotations.isPreferredResponse=true` means the assistant response was marked as preferred.

## Workflow

1. Call `GET /history/topics` to identify the relevant topics.
2. Page through `GET /history/topics/:topicId/transcript` for each topic you want to analyze.
3. Use `GET /history/search/messages` for targeted retrieval when needed.
4. Run the local Python analysis to generate a Markdown report.
5. Keep conclusions descriptive and probabilistic. Do not produce clinical or diagnostic claims.

## Scripts

- `scripts/cherry_history_client.py`
  - Local HTTP client with pagination helpers.
- `scripts/analyze_chat_history.py`
  - Produces a Markdown research report from Cherry history data.

## Example

```bash
python .agents/skills/cherry-chat-research/scripts/analyze_chat_history.py \
  --topic-limit 20 \
  --output /tmp/cherry-history-report.md
```

To install this public skill from the repository with [`vercel-labs/skills`](https://github.com/vercel-labs/skills):

```bash
npx skills add ifastcc/cherry-studio --skill cherry-chat-research -a codex -a claude-code
```

## Output Contract

The generated report should contain these sections:

- `Executive Summary`
- `Topic & Interest Evolution`
- `Conversation Behavior`
- `Style & Cognitive Cues`
- `Emotional / Value Signals`
- `Limits & Uncertainty`

## Safety Rules

- Do not claim diagnoses, disorders, IQ, or personality types.
- Prefer phrasing like "language cues suggest", "the chat history shows", or "within this dataset".
- Always include uncertainty and dataset limits.
