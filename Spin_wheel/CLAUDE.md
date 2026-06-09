# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

3-day in-person prize-wheel event ("돌림판 이벤트") run on an iPad. A single HTML page renders a Canvas wheel; every spin's outcome is decided server-side by a Google Apps Script web app that reads/writes a Google Sheets database. Visual slice sizes on the wheel deliberately do **not** match the real probabilities — the server is the only authority on what gets awarded.

## Architecture

```
[iPad Safari]  ──HTTP──>  [GAS web app: doGet]  ──>  [Google Sheets DB]
fancy_roulette.html       gas-backend_fancy.gs       Config/Stock/DailyAllocation/Log
```

- **Frontend** (`fancy_roulette.html`, single file, ~1.2MB with base64-embedded prize images): renders the wheel, animates the spin, calls `GAS_URL?action=spin`, then snaps to the slice matching the server-returned `prize` id. Prize images, logos, and segment metadata (`SEG` array) are all hardcoded here.
- **Backend** (`gas-backend_fancy.gs`): five endpoints over `doGet` — `spin`, `stock`, `debug`, `init`. Spin acquires a `LockService` script lock, computes the prize, decrements stock + daily-used, and appends a Log row.
- **Storage** (Google Sheets): four sheets. `Stock` holds `remaining` per prize; `DailyAllocation` holds `dayN_alloc`/`dayN_used` columns per day; `Log` is the audit trail with a `source` column.

The frontend has no understanding of probabilities, allocations, or daily caps — those exist only on the server. The client only knows visual slice mapping.

## Where files live (important — there's legacy clutter)

Active work happens in `Spin_wheel/`. The **parent directory** (repo root) contains old artifacts (`roulette.html`, `gas-backend.gs`, raw PNG sources) that are mostly untracked or being phased out — do not edit them. The two files that matter are:

- `Spin_wheel/fancy_roulette.html` — the live frontend
- `Spin_wheel/gas-backend_fancy.gs` — the live backend

`Spin_wheel/gas-backend.OLD-2026-04.gs.bak` is a manual backup; ignore it.

## Deployment workflow (the non-obvious chain)

This project has no build, no tests, no lint. "Deploying" means manually pushing code into Google's editors:

1. **Backend changes**: copy `gas-backend_fancy.gs` contents → paste into Apps Script editor → **새 배포 (New deployment)** → access "모든 사용자" — **NOT just save**. Saving alone doesn't update what `?action=spin` runs.
2. **Verify deploy**: `curl GAS_URL?action=debug` and check the `version` field matches the constant in the source (currently `v5-2026-06-10-3days-no-reserve`).
3. **Sheet schema changes**: any edit to `PRIZES` (stock totals, new keys, baseProbability) requires running `manualRebase` (preserves Log) or `manualInit` (wipes Log) from the Apps Script editor — **the running spin code reads `baseProbability` from the Stock sheet, not from the `PRIZES` constant**. Code-only edits won't take effect at runtime until a rebase syncs the sheet.
4. **Frontend changes**: edit `fancy_roulette.html`, reload on iPad. If hosted via GitHub Pages, push to `main` and wait for Pages rebuild.
5. **GAS_URL** lives in `fancy_roulette.html` at the top of the `<script>` section.

Editor-only helpers (not exposed via `doGet` other than `init`):
- `manualInit` — fresh-install only (deletes Log)
- `manualRebase` — preserves Log, recomputes daily allocation from current `Stock.remaining`
- `manualDebug` — logs `handleDebug()` output to View → Logs

## Critical behavioral invariants

These are non-obvious and easy to violate in edits:

1. **Strict daily budget (recent change)**. Today's max distribution = `dayAlloc + rolledOver`. Fallback weighs by `effectiveRemaining`, never by raw stock — so if today's budget is exhausted but stock remains, the spin returns the "오늘 마감" error rather than borrowing future-day budget. Any change that lets stock drain past today's budget cap breaks this invariant.
2. **ABSORBER pattern**. `vita500` is hardcoded as the absorber: its stored `baseProbability` (0.5161) is ignored at runtime; it always gets `1 - sum(others_with_positive_prob)`. Other prizes use their literal `baseProbability` from the Stock sheet.
3. **Probability is calibrated to stock ratio**. `baseProbability_i ≈ totalStock_i / sum(totalStock)`. If demand matches `EVENT_CONFIG.dailyWeights × totalStock` per day, each prize's expected draws per day exactly equal its `dayAlloc`. Changing one without the other unbalances the day-level math.
4. **`source` column on Log** classifies each draw as `'today'` / `'rollover'` / `'overflow'`. `'overflow'` is currently unreachable code (strict Fallback prevents it) — kept as defensive sentinel.
5. **`KST` is explicit in date math**. `getEffectiveDay_` uses `Utilities.formatDate(..., 'Asia/Seoul', ...)` + `Date.UTC` to avoid the spreadsheet owner's timezone leaking in. Log row timestamps, however, still inherit the spreadsheet's locale.
6. **Concurrency**: `handleSpin` holds a script lock for the full read-compute-write cycle. `handleStock`/`handleDebug`/`handleInit` acquire no lock — calling `?action=init` while spins are in flight will corrupt state.

## When debugging in production

- `?action=debug` returns a snapshot of how the server interprets today's date, per-prize effective remaining, computed probabilities, and `usedFromToday` / `usedFromRollover` breakdown. Use this before assuming a bug — the cause is usually a stale sheet, not the code.
- Log entries with `source='rollover'` are normal in later days. Many `source='today'` rows piling up means demand is matching plan.
- The "재고 안 줄어듦 → 재배포" troubleshooting in `setup-guide.md` is real: GAS web apps serve the **last deployed** version, not the saved one.

## Git workflow

- Default branch: `main`. There is no PR review process — pushes go straight to production after a manual GAS redeploy.
- Remote moved from `SPH_Event-` to `SPH_Event` (trailing dash dropped). Push still works via redirect but emits a warning; update with `git remote set-url origin https://github.com/kwonsez/SPH_Event.git` to silence.
- `.claude/` and `*.bak` files are intentionally not tracked.
