# Comment Generation Optimization — Change Log

Track **only** changes related to AI comment generation. Do not log unrelated work here.

**Scope (in):** generation prompts, Gemini calls, transcript/metadata fetch for generation, batch/regenerate paths, post-processing of generated text.  
**Scope (out):** comment posting, VPN, OAuth, accounts, campaigns, UI chrome (unless a generation API contract change forces a minimal UI tweak).

---

## Baseline (pre-optimization) — 2026-07-23

### Flow
1. UI (wizard / discover) → `POST /api/comments/generate-batch` | `/generate-from-url` | `/regenerate`
2. Fetch YouTube video details + transcript
3. Build language/tone/voice slots → Gemini prompt → parse JSON → shorthand + score
4. Return comments for review (posting is separate)

### Core files
| File | Role |
|------|------|
| `src/controllers/commentController.js` | Orchestration: fetch, generate, batch, regenerate |
| `src/utils/commentGeneration.js` | Slot prompts, JSON parse, scoring, post-process |
| `src/utils/commentSlots.js` | Slot builders + default mixes |
| `src/utils/spellingErrors.js` | Casual shorthand / text-speak |
| `src/services/geminiService.js` | Gemini model chain + retries |
| `src/routes/commentRoutes.js` | Route wiring |
| `public/index.html` | Wizard/discover generation triggers only (if touched) |

### Known bottlenecks (candidates)
| ID | Issue | Impact |
|----|--------|--------|
| B1 | Batch processes videos **sequentially** (details → transcript → Gemini) | High latency for multi-video |
| B2 | Regenerate **re-fetches** details + transcript every time | Extra YouTube / transcript cost |
| B3 | Discover UI calls `/generate-from-url` **one video at a time** | Serial client round-trips |
| B4 | No cache for video details / transcript across generate + regenerate | Repeated network work |
| B5 | Large transcript fetched (up to ~14k) while prompt uses ~4k | Wasted fetch/process |
| B6 | Gemini model fallback + retries on 503/quota | Long-tail latency / hard failures |
| B7 | Slot path has **no template fallback** on Gemini failure (legacy path does) | Batch fails hard under quota |
| B8 | Long HTTP request stays open for full batch (no queue/stream) | Timeouts on large batches |

---

## Change log

| Date | Change | Files | Bottleneck | Notes |
|------|--------|-------|------------|-------|
| 2026-07-23 | Created this tracking file; codebase scan only | `COMMENT_GENERATION_OPTIMIZATION.md` | — | No generation code changed yet |
| 2026-07-23 | Mock accounts bypass for wizard Step 2→3 (generation testing) | `.env`, `src/app.js`, `public/index.html` | — | `WIZARD_MOCK_ACCOUNTS=true`; posting blocked when mocks used |
| 2026-07-23 | Fix mock flag not applying (stale node on :5003); refresh flag on Step 2 | `public/index.html` | — | Kill old process; re-fetch `/api/config/client` when entering accounts step |
| 2026-07-23 | Fix broken `buildWizardMockAccounts` header (JS syntax error blocked login) | `public/index.html` | — | Accidental truncation during mock-accounts edit |
| 2026-07-23 | Wizard filter redesign for generation | `commentSlots.js`, `commentGeneration.js`, `commentController.js`, `public/index.html` | — | Removed Gen Z + presets + text-speak UI; added positive/negative mix; comment total = sum of language counts; naturalness via prompt |
| 2026-07-23 | Hard-ban Gen Z slang; restore misspellings; optional intent + smart video angles | `commentGeneration.js`, `spellingErrors.js`, `commentSlots.js`, `commentController.js`, `commentRoutes.js`, `public/index.html` | — | `/suggest-angles`; strip Gen Z phrases post-gen; misspell % default 40 |
| 2026-07-23 | Fix ignored intent, Gen Z leak, nonsense comments | `commentGeneration.js`, `spellingErrors.js`, `public/index.html` | — | Hard intent in prompt + keyword gate; stronger slang strip; mild typos only on EN/HI; no native-lang gibberish shorthand |
| 2026-07-23 | Redesign Step 3 filters UI; fix angle chip selection; Khasi default | `public/index.html`, `commentSlots.js`, `commentGeneration.js` | — | Removed optional intent box; index-based angle toggles; clearer smart-angles card |
| 2026-07-23 | Fix review horizontal scroll; improve Khasi meaning + video relevance | `public/index.html`, `commentGeneration.js` | — | overflow guards; meaning_en + topic grounding; clearer Khasi fallbacks |
| 2026-07-23 | Two-pass generation for sentence sense | `commentGeneration.js`, `commentController.js` | — | Pass 1 English draft (temp 0.55) → Pass 2 language adapt (temp 0.4); `looksLikeCompleteThought` gate |
| 2026-07-23 | Short-form misspellings + gen failure hardening | `spellingErrors.js`, `commentGeneration.js`, `commentController.js`, `geminiService.js`, `.env` | — | what→wht etc; strip ```json fences; skip/fail-soft adapt; drop broken 2.5-flash-lite fallback |
| 2026-07-23 | Fix Khasi→English leak; add neutral sentiment | `commentSlots.js`, `commentGeneration.js`, `commentController.js`, `public/index.html` | — | never use EN drafts for native langs; English-body detector; positive/neutral/negative mix |
| 2026-07-24 | Anti-mid comment quality pass | `commentGeneration.js`, `commentController.js` | — | sharper prompts + style rotation; ban mid filler; punchier fallbacks; draft temp 0.85 / adapt 0.55 |
| 2026-07-24 | Khasi direct-gen + ban EN/Khasi salad | `commentGeneration.js`, `commentController.js` | — | native langs skip EN→adapt; few-shot Khasi; strict mix + meaning_en sense gates; pure Khasi fallbacks |
| 2026-08-04 | Add user keywords input + improve smart-angles loader | `public/index.html`, `commentController.js`, `commentGeneration.js` | — | optional `userKeywords` feed is added to prompt topic grounding; loading UI now clearly shows analysis in progress |

---

## Decisions / constraints
- Optimize comment generation only; leave posting, VPN, and unrelated features alone.
- Prefer measurable wins (latency, fewer API calls, resilience) over broad refactors.
- Record each code change in the table above before/when shipping it.
- **GitHub:** remote will be https://github.com/mechatronlab/yt_automation_backend.git — push only when asked, on a **new branch** (not `main`), after comment quality feels good. Keep secrets (`.env`, service accounts) out of git.

---

## Next steps (proposed — not started)
1. Manually verify Khasi / mixed-language comments still read as complete thoughts after two-pass
2. Cache video details + transcript for regenerate / repeat URLs (B2, B4)
3. Parallelize per-video work in `generateCommentsBatch` with a safe concurrency limit (B1)
4. Trim transcript fetch to what the prompt actually uses (B5)
5. Align slot-path fallback with legacy template fallback where safe (B7)
6. When quality OK: init git → branch `feature/comment-generation-opt` → push (do not touch `main`)
