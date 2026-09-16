# Agent Note: The retry card mutates one nested field instead of the whole policy

Status: implemented

English | [中文](2026-09-08-retry-card-nested-field-mutation.zh.md)

## Problem

The DeepSeek adapter's model-request retry policy lives under its settings namespace, but the only writer was the raw settings document — editing the retry count meant hand-writing a nested YAML object with backoff and retryable-code fields the editor must not lose or invent.

## Decision

The `/settings → plugins` card for `llm-deepseek` stages two fields (mode, and in normal mode the retry count) and writes through one namespace mutation addressing exactly the changed path: a stored normal policy mutates only `retryPolicy.maxRetries`, while a first write or a mode switch replaces the whole `retryPolicy` object and lets the schema's own defaults fill backoff and retryable codes. The adapter's existing `onChange` hook re-registers the route in place, so a committed count applies to the next request without a restart.

## Alternatives considered

- **Editing retryPolicy on the Models page.** Rejected: that page's editor owns the model catalog and credentials; a retry count is plugin configuration with its own namespace, and the plugin-configuration tab already pairs cards to namespaces without any page change.
- **Writing the whole retryPolicy object from staged form state.** Rejected: the card would clobber `backoff` and `retryableCodes` values a deployment stored in its composition — fields the card deliberately does not show — and regeneration would have to re-invent them.
- **A generic "provider advanced settings" card.** Rejected: the schema union's shape differs per mode and per provider; one typed card per provider keeps validation and copy exact.

## Consequences

- Operators change the retry count (or switch to unbounded retry) from the Web UI; the count survives restarts in the settings document and outranks the composition default until cleared.
- The card stays honest about scope: fields it does not render are never written, and a blank count stages a clear that falls back to the schema default (five) on save.
- A failed save keeps the draft and the failure badge, matching every other card in the section.
