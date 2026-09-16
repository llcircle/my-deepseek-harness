# Agent Note: The correction loop is fuse, archive, clear, inject

Status: implemented

English | [中文](2026-09-08-correction-loop-archive-clear-inject.zh.md)

## Problem

The first `/correct-errors` pass wrote a fresh reflection from the journal and left the journal growing forever. Lessons from earlier passes never reached the next one, every old failure was re-read on every pass, and the resulting document lived per-project where no other session saw it.

## Decision

The correction loop now has four steps. Fuse: the command reads the journal and the capped tail of the existing system-level reflection document and hands both to the child, which rewrites the complete document with one new dated section. Archive: the raw journal content is appended to `<dshHome>/tool-error-log-archive.jsonl`, the append-only ledger. Clear: the journal truncates to empty, bounding the next pass. Inject: the new `error-reflection-prompt` plugin contributes the document's capped tail as the `deployment:error-lessons` system-prompt section, so every agent carries the latest lessons. The document and the plugin default to the same Harness-home path; archiving and clearing run only after the child has started, so a failed start never loses journal data.

## Alternatives considered

- **Letting the child archive and clear the journal.** Rejected: file bookkeeping is deterministic work, and giving the child write authority over its own input log makes a model mistake capable of destroying evidence.
- **Merging reflections inside the command with string concatenation.** Rejected: synthesis is model work; concatenation would only duplicate dated sections instead of condensing them.
- **Injecting the whole document.** Rejected: the document grows without bound; the capped heading-boundary tail keeps prompt cost bounded while the archive preserves everything.

## Consequences

- Each pass starts from an empty journal; the archive is the permanent record of every raw failure.
- Lessons are deployment-global (Harness home), matching the global journal scope.
- The injected section shifts the request prefix when the document changes — acceptable for low-frequency, user-invoked corrections.
