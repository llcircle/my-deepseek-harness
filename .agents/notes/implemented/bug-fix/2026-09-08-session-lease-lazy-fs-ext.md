# Agent Note: The session lease loads fs-ext lazily

Status: implemented

English | [中文](2026-09-08-session-lease-lazy-fs-ext.zh.md)

## Problem

`lease.ts` imported `fs-ext` statically, so loading the JSONL persistence backend required the native flock binding to exist on EVERY platform — including Windows, whose lease implementation never calls flock (it holds a named kernel semaphore through koffi). A Windows machine without the fs-ext binding could not boot the harness at all, for a binding its own write path never uses.

## Decision

`flockAsync` now loads fs-ext with a dynamic `import('fs-ext')` on first use. The win32 branch returns before any flock call, so Windows never loads the binding; the POSIX path loads it exactly where the lock is taken; the worker deployment is unaffected because the bundler alias for `fs-ext` rewrites dynamic imports to the same stub as static ones.

## Alternatives considered

- **A platform split package (`lease.posix.ts` / `lease.win32.ts`).** Rejected: the acquire flow is one linear contract (mkdir → branch → verify inode → return); splitting it would duplicate the inode-verification retry loop across two files to move one import.
- **An optional peer with a require-guard at module top.** Rejected: a top-level try/catch require still runs on every platform at load, and swallowing the load error there would turn a genuine POSIX misconfiguration into a runtime failure at first lock instead.

## Consequences

- Windows boot no longer depends on a POSIX-only native binding; `pnpm install` machines without MSVC can run the harness (koffi, which Windows DOES use, still needs its toolchain).
- A missing fs-ext binding on POSIX surfaces at first session write with the dynamic import's own error, unchanged in meaning from the static import's load-time error.
