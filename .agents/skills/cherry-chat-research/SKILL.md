---
name: cherry-chat-research
description: Conduct open-ended research on Cherry Studio chat history through the local /v1/history API. Use when the user wants a deep reading of one person's chat patterns, recent concerns, values, motives, personality texture, emotional pressures, or a report that helps them feel seen.
---

# Cherry Chat Research

This skill turns the model into a chat-history researcher.
It is not a dashboard generator and not a fixed-schema analytics pipeline.

The goal is to study Cherry Studio history deeply enough that the final output feels insightful, alive, and personally meaningful.
The report can be reflective, psychological, narrative, philosophical, or portrait-like as long as it is grounded in the actual chat record.

## Inputs

These environment variables are optional overrides:

- `CHERRY_API_BASE_URL=http://127.0.0.1:<port>/v1`
- `CHERRY_API_KEY=<api key>`
- `CHERRY_API_CONNECTION_FILE=/absolute/path/to/api-server.json`

If they are absent, the helper client will try to auto-discover Cherry Studio's local connection profile file.

## Data Semantics

- `clear` messages are context boundaries, not normal content.
- A `segment` is the continuous message span after a `clear` boundary.
- A `round` is one user message plus assistant messages whose `askId` matches that user message id.
- `message.annotations.segmentId` and `message.annotations.roundId` are structural anchors, not conclusions.
- `message.annotations.isPreferredResponse=true` means the assistant response was marked as preferred.

## What This Skill Is For

Use this skill when the user wants more than a factual summary.
The real job is to understand what kind of person appears through the history and what seems emotionally, psychologically, or existentially important in their recent conversations.

Good outputs often help answer questions like:

- What keeps returning in this person's inner life?
- What do they seem to want, fear, avoid, or long for?
- What pressures or contradictions shape their decisions?
- What kind of self-story do they keep telling?
- What has recently changed in tone, focus, or identity?
- What is psychologically meaningful here, even if it is not clinically precise?

## Research Style

Do not force the material into a rigid template.
You are allowed to think freely and to decide what structure best fits the history you find.

You may draw from lenses such as:

- personality texture
- narrative identity
- values and motives
- fear, shame, desire, and control
- attachment and relationships
- cognitive style and decision style
- self-image and self-criticism
- existential concerns, meaning, freedom, responsibility

These are interpretive lenses, not cages.
Use them when they help the user feel understood.

## Suggested Workflow

This is a suggested research process, not a mandatory checklist.

1. Start broad.
   Look at the topic catalog to understand the terrain.
2. Form hunches.
   Notice what seems emotionally charged, repeated, unfinished, or recently active.
3. Trace motifs.
   Use search to follow recurring phrases, concerns, identities, or conflicts.
4. Read closely.
   Open transcripts around the promising areas and inspect the surrounding messages.
5. Revise.
   Look for counterexamples, shifts, or moments that complicate your first impression.
6. Write.
   Produce a report, portrait, essay, letter, or HTML artifact that feels truer than a dashboard.

## Tone And Ambition

Aim for something that feels like a deep reading by an intelligent observer, not a safe internal memo.

The user should ideally feel:

- seen
- understood
- slightly surprised in a truthful way
- invited into deeper reflection

It is fine to be psychologically rich.
It is fine to mention personality tendencies, relational style, or enduring traits when that adds meaning.
Do not flatten the person into a label.

## Evidence

Do not drown the user in citations, but do stay grounded.

- Important claims should come from real messages, recurring patterns, or repeated motifs.
- Use quoted evidence when it sharpens the report.
- If the evidence is weak or mixed, say so.

## Outputs

There is no fixed required structure.
Choose the shape that best fits the material.

Valid deliverables include:

- an insight report
- a personal portrait
- a psychological reading
- a recent-interest study
- a narrative essay
- a standalone HTML reading experience

If you make HTML, design it freely.
Do not assume a fixed dashboard layout or a fixed section list unless the material genuinely calls for it.

## API Surface

Primary endpoints:

- `GET /history/topics`
- `GET /history/topics/:topicId`
- `GET /history/topics/:topicId/transcript`
- `GET /history/messages/:messageId`
- `GET /history/search/messages`

## Scripts

- `scripts/cherry_history_client.py`
  - Minimal local HTTP client for the history API.
  - Supports env overrides and local connection-profile auto-discovery.
- `scripts/analyze_chat_history.py`
  - Exports a raw local research workspace with topic catalogs, readable transcripts, and optional search results.
  - This script does not generate conclusions. It prepares source material for the model to study.

## Example

```bash
python .agents/skills/cherry-chat-research/scripts/analyze_chat_history.py \
  --topic-limit 20 \
  --search "AI" \
  --search "焦虑" \
  --output-dir /tmp/cherry-chat-research
```

The command prints the workspace directory.
From there, read `catalog.md`, inspect `topics/*.md`, and write the final report yourself.

## Safety

- Avoid clinical diagnosis unless the user explicitly asks for that level of framing and the evidence is unusually strong.
- Avoid pretending certainty where there is only resonance or pattern.
- Stay close to the material.
- Prefer honest, vivid interpretation over empty caution language.
