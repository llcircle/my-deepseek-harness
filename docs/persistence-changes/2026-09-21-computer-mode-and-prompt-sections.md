---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-21-computer-mode-and-prompt-sections

English | [中文](2026-09-21-computer-mode-and-prompt-sections.zh.md)

## Summary

Two persisted types advance by addition only. The session event vocabulary gains `computer/mode`, which records the computer-use capability toggle as `{ active: boolean }`. The persisted `request/header` event gains an optional `systemSections` snapshot of the rendered prompt sections. No existing value changes type and no optional property becomes required, so the Session format version is retained.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-21-computer-mode-and-prompt-sections
baseline: false
changes:
  - root: "event:computer/mode"
    previous: null
    after: "b0ac99225dac86c22503bc7bad0b09e704e8ff00c8068895fd8418f7305fe648"
    decision: same-version
  - root: "event:request/header"
    previous: "2026-09-11-initial"
    after: "2212c188a1c336bcb1cdbbc2523e5595e7f97d3b2369a6c7bd67bad8ed33f457"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

`computer/mode` is a new ordinary event type. Records written before it exists simply never contain it, and the `computer` projection folds an absent event to disabled, so reading and replaying an older log is unchanged. The type joins the build's known event vocabulary, which is deliberately conservative in the forward direction: a build that predates the event refuses a log containing it instead of silently skipping a required event, which is why the fixed rules classify an ordinary event-type addition as a retained version. `systemSections` is an optional addition to `event:request/header`, so existing records can omit it. Canonical form drops the field when the list is empty, and header equality deliberately excludes it, so its presence never rewrites the request envelope. The system prompt reaches the model as derived history (surface node 0, a `system/message` event) rather than through this snapshot; a reader that ignores it loses only source-aware prompt display, and replay is unaffected.

<a id="verification"></a>
## Verification

`vitest run scripts/persistence-changes.spec.ts scripts/persistence-schema.spec.ts` passed 73 tests, including the digest-stability cases and the fingerprint over every real repository event. `vitest run packages/core/tools packages/computer/tool-computer-use packages/preset` passed 718 tests, including the generic script entry's grammar and dispatch suite, the capability's verb-table seam, and the enable/disable integration. `tsx scripts/persistence-changes.ts --check` classified exactly these two additions, inferred `same-version` for both, and passes with this record in place.

<a id="dev-note"></a>
## Dev Note

None.
