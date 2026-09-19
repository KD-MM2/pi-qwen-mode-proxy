# pi-qwen-mode-proxy v1.3.2 — True thinking-off for Qwen models on omp

**Date:** 2026-09-19
**Repo:** `pi-qwen-mode-proxy` (installed via symlink at `~/.omp/plugins/node_modules/pi-qwen-mode-proxy`)
**Server:** llama.cpp @ `http://192.168.0.2:3334`, model `Qwen3.8-27B` (GGUF)
**Wire:** `api: openai-responses` (`/v1/responses`), provider `llama.cpp` in `~/.omp/agent/models.yml`

---

## 1. TL;DR

Profiles with `thinking: false` (e.g. `instruct`) now produce **zero thinking tokens** on Qwen models, even though the omp runtime clamps "off" to the minimum effort level. The extension forces true off **on the wire**: it strips the effort fields the runtime injects and sets `chat_template_kwargs.enable_thinking: false`, which the Qwen3-style chat template baked into the GGUF maps to `/no_think`.

The key enabling fact, established by live probes against the actual server: **this GGUF honors `enable_thinking: false`** — contrary to the omp model catalog's description of the official Qwen 3.8 template. The kwarg even wins when a clamped `reasoning: { effort: "low" }` is still present in the payload.

---

## 2. Problem

The extension's `instruct` profile sets `thinking: false`. The intent: instruct mode means no thinking at all.

What actually happened on omp:

1. The extension called the runtime API to set thinking "off".
2. omp's runtime clamped "off" to the **minimum effort** for `requiresEffort` models (Qwen 3.8 is one).
3. The session then reported level `low` — and every outgoing payload carried `reasoning: { effort: "low" }`.
4. The chat template interpreted that as "think, at low effort" → thinking was emitted.

So the profile said "off", the UI could be toggled off, but the model still thought. The clamp is **by design** in omp: for models whose catalog entry says thinking is mandatory, the runtime refuses to send a payload with no thinking, because (per the catalog) the official Qwen 3.8 chat template **throws** if `enable_thinking: false` is passed.

Versions 1.3.0–1.3.1 accepted that premise and implemented *cosmetic* clamped-off tracking: the extension remembers that it applied "off" even though the runtime reports `low`, and the profile-switch notification tells the user "the runtime clamped off to low — press Ctrl+T to hide thinking blocks". Honest, but not a fix.

## 3. How omp encodes thinking on the wire

Two wire formats exist for the same llama.cpp server, and they encode thinking differently:

| | **Responses wire** (`api: openai-responses`) | **Completions wire** (`api: openai-completions`) |
| --- | --- | --- |
| Endpoint | `/v1/responses` | `/v1/chat/completions` |
| Thinking carrier | `reasoning: { effort: "low" \| "medium" \| ... }` | `enable_thinking: true/false`, top-level `reasoning_effort`, and `chat_template_kwargs: { reasoning_effort }` |
| Native `enable_thinking` support | **None** — the Responses serializer has no such field | Yes — the Qwen branch of the shared serializer emits it |
| Off on a `requiresEffort` model | Clamped: `reasoning: { effort: "low" }` | Clamped: `enable_thinking: true` + `reasoning_effort: "low"` (+ twin inside kwargs) |

The clamp lives in `stream.ts` (`normalizeMandatoryReasoningOptions`): when thinking is disabled on a `requiresEffort` model, it substitutes the minimum effort instead of letting the request go out with no thinking.

Consequence: **with only the runtime's own encoding, "off" on Qwen 3.8 is indistinguishable from `low`** — the payload is byte-identical. That was the wall the v1.3.1 design hit.

## 4. Investigation: live probes

Before changing anything, the actual server was probed. The catalog claim is about the *official* Qwen 3.8 template; the template is baked into each GGUF at quantization time, and community quants frequently ship the classic Qwen3-style template instead. The only way to know is to ask the server.

### 4.1 Environment

- llama.cpp server at `http://192.168.0.2:3334`
- Served models include: `Qwen3.8-27B`, `Qwen3.8-27B-735`, `Qwen3.8-27B-Swift{,-Q5M,-Q5S,-UC}`, `Nail-Qwen3.6-35B-A3B-{Q4,Q5}`, `KAT-Coder-V2.5-Dev`, `Cyber-Tiel-Coder-35B-A3B`
- All probes used the exact model id `Qwen3.8-27B` with a minimal prompt ("reply with exactly: OK") and a small token cap
- Note: an early probe hit `Nail-Qwen3.6-35B-A3B-Q4` (the first `/qwen/i` match in the model list) and got HTTP 500 "failed to load" — that model wasn't loaded. Always probe with the exact, loaded model id.

### 4.2 Probe matrix

| # | Wire | Thinking-related fields sent | HTTP | Latency | Output |
| --- | ------ | ------------------------------ | ------ | --------- | -------- |
| A | `/v1/chat/completions` | `chat_template_kwargs: { enable_thinking: false }` | 200 | ~15.6 s | message only, **0 reasoning chars**, content `OK` |
| R1 | `/v1/responses` | `chat_template_kwargs: { enable_thinking: false }` | 200 | ~15.3 s | `output_types: [message]`, **no reasoning item**, text `OK` |
| R3 | `/v1/responses` | `reasoning: { effort: "low" }` **+** `chat_template_kwargs: { enable_thinking: false }` | 200 | ~4.7 s | `output_types: [message]`, **no reasoning item**, text `OK` |

### 4.3 Findings

1. **This GGUF honors `enable_thinking: false`** — it does not throw. The classic Qwen3-style template maps the flag to the `/no_think` soft prompt, producing zero thinking tokens.
2. **It works on both wire formats**, including `/v1/responses` (the one omp actually uses with this server), via `chat_template_kwargs`.
3. **The kwarg wins over a concurrent effort field** (R3). Even when the payload still carries the clamped `reasoning: { effort: "low" }` — exactly the state omp produces — the template suppresses thinking. R3 is the decisive probe: it is the *exact wire state* the extension will create.

### 4.4 Why the catalog claim doesn't apply

The omp catalog's `requiresEffort` / "template throws on `enable_thinking: false`" entry for Qwen 3.8 describes the **official 3.8 template**. The served GGUF ships a different (classic Qwen3-style) template. Both statements are true of different artifacts — the probe settles which one applies here.

**Implication for the design:** the failure mode is now the *inverse* of the catalog's. If this GGUF were ever replaced by one built with the official template, instruct-mode requests would fail with a template error instead of silently thinking. That caveat is documented in the README (see §9).

## 5. Solution: hard-off wire rewrite

### 5.1 Mechanism

In the `before_provider_request` hook — which fires after the runtime has built the payload (including the clamped effort fields) but before it is sent — the extension, when the **active profile has `thinking: false`** and the **request targets a Qwen model**, rewrites the payload:

1. Delete `payload.reasoning` — the Responses-wire effort carrier.
2. Delete `payload.reasoning_effort` — the Completions-wire top-level carrier.
3. Flip `payload.enable_thinking` to `false` **only if it is already a boolean** (Completions wire; never *added* on the Responses wire, which has no such field — avoids unknown-field risk).
4. Merge `payload.chat_template_kwargs`: delete `reasoning_effort`, set `enable_thinking: false`, preserve every other kwarg.

Resulting wire state on the Responses wire: no `reasoning` field, `chat_template_kwargs: { enable_thinking: false }` → the template emits `/no_think` → **zero thinking tokens**.

`applyHardOff` is idempotent (re-running it is a no-op) and returns whether it rewrote the payload.

### 5.2 Code

`extensions/config.ts`:

```ts
/** Qwen models only — `enable_thinking` is Qwen template semantics. */
const QWEN_PATTERN = /qwen/i;

/**
 * Force true thinking-off on an outgoing Qwen payload.
 * ... (full doc comment in source: rationale, probe evidence) ...
 * Mutates `payload`. Returns true when rewritten.
 */
export function applyHardOff(
 payload: Record<string, unknown>,
 model: ModelIdentity | undefined,
): boolean {
 if (!isQwenModel(payload, model)) return false;
 if (payload.reasoning !== undefined) delete payload.reasoning;
 if (payload.reasoning_effort !== undefined) delete payload.reasoning_effort;
 if (typeof payload.enable_thinking === "boolean") payload.enable_thinking = false;
 const prev = (payload.chat_template_kwargs ?? {}) as Record<string, unknown>;
 const kwargs: Record<string, unknown> = { ...prev };
 delete kwargs.reasoning_effort;
 kwargs.enable_thinking = false;
 payload.chat_template_kwargs = kwargs;
 return true;
}
```

`extensions/index.ts` (hook, after sampling-parameter injection):

```ts
// Qwen models: the runtime's clamped "off" would otherwise re-enable
// minimum-effort thinking (see applyHardOff).
if (params.thinking === false) applyHardOff(payload, ctx.model);
return payload;
```

### 5.3 Design decisions

| Decision | Rationale |
| --- | --- |
| **Probe before implementing** | The entire feature hinges on the template baked into *this* GGUF. A probe against the real server (R3) is worth any amount of catalog reading. |
| **Kwarg as the primary force, effort-strip as belt-and-suspenders** | R3 proved the kwarg wins even with effort present, so the rewrite is robust to payload-shape drift between runtime versions — and stripping the effort still removes the semantic noise. |
| **Qwen-only gate** (`/qwen/i` on payload model or session model id/name/provider) | `enable_thinking` is Qwen template semantics. The same server also serves KAT-Coder and Cyber-Tiel models; their payloads must be untouched. |
| **Profile-driven scope, not toggle-driven** | Applies only when the *active profile* has `thinking: false`. A user who manually toggles thinking off at runtime on a thinking profile still gets the runtime's normal clamped behavior. |
| **Top-level `enable_thinking` only flipped if present** | The Responses wire has no such field; adding unknown fields to it is unnecessary risk. The Completions wire has it, so it's normalized there. |
| **Merge kwargs, never replace** | Preserves any other kwargs (e.g. `thinking_budget`) the runtime or user may have set. |
| **No config knob** | Single-user personal extension with a visible failure mode (500 per request, documented). A flag would be weightless complexity. |

### 5.4 User-facing note

`clampedOffNote(offLevel, hardOff)` gained a second argument. On a Qwen model the profile-switch notification now says the wire **sends** `enable_thinking: false` (no thinking emitted) — no Ctrl+T advice. For clamped **non-Qwen** models the old note (with the Ctrl+T / `hideThinkingBlock` advice, oh-my-pi#626) is kept.

## 6. What changed (v1.3.1 → v1.3.2)

| File | Change |
| --- | --- |
| `extensions/config.ts` | New `QWEN_PATTERN`, `modelCandidates()` (shared with refactored `isTargetModel`), `isQwenModel()`, `applyHardOff()`; `clampedOffNote` now takes `(offLevel, hardOff)` with a hard-off variant message |
| `extensions/index.ts` | Imports the two new helpers; `applyThinking(profile, ctx)` gains `ctx` so the note can check the Qwen gate (all 5 call sites updated: create/edit/delete/switch profile, session_start); `before_provider_request` calls `applyHardOff` for `thinking: false` profiles; header doc comment updated |
| `test-smoke.ts` | `clampedOffNote` tests updated to 2-arg; new block: Responses-wire rewrite, Completions-wire rewrite, kwargs merge/preservation, non-Qwen gate (payload and session identity), idempotency — 15 new checks |
| `README.md` | New "True off for Qwen models" section (mechanism, probe evidence, GGUF-template caveat); omp bullet corrected (the old claim "Qwen 3.8 rejects `enable_thinking:false`" is scoped to the official template); Ctrl+T paragraph scoped to clamped non-Qwen models; "How It Works" mentions the hard-off rewrite |
| `package.json` | `1.3.1` → `1.3.2` |

## 7. Verification

| Check | Result |
| --- | --- |
| Smoke suite (`bun test-smoke.ts`) | **106/106 pass**, exit 0 (91 pre-existing + 15 new) |
| Type check (`bunx tsc --noEmit`) | clean, no output |
| Live probe evidence chain | (a) omp sends `reasoning: { effort: "low" }` when thinking is off on the Responses wire (runtime clamp + Responses serializer); (b) the extension strips it and adds the kwarg (unit tests); (c) that exact wire state produces zero thinking (probe R3, live) |
| Installed copy | `~/.omp/plugins/node_modules/pi-qwen-mode-proxy` symlinks to the workspace (identical mtime on `extensions/index.ts`: 2026-09-19 15:45:33); `applyHardOff` present in the installed `config.ts` and wired in the installed `index.ts` |

**Post-verification fix:** during report preparation an indentation repair on the kwargs line was found to have introduced a typo in the identifier on that line (`keywords` → correct: `kwargs`). It was corrected in place (the identifier derived from the adjacent `delete kwargs.reasoning_effort;` line) and the full verification re-run: 106/106 pass, tsc clean.

## 8. User-facing behavior after v1.3.2

- **Start a new omp session** (the extension re-imports on session start).
- Switch to `instruct` (or any `thinking: false` profile) on a Qwen model → **no thinking blocks appear at all**; the switch notification states that the wire sends `enable_thinking: false`.
- `thinking`/`coding` profiles (`thinking: true`) are unchanged — thinking works as before.
- `Ctrl+T` (`hideThinkingBlock`, #626) is no longer needed for Qwen models; it remains the workaround for clamped non-Qwen models.
- Works identically under pi and omp (dual-runtime), on both wire formats.

## 9. Caveats and failure modes

1. **Template provenance is the load-bearing assumption.** Behavior depends on the chat template baked into the GGUF at quantization time. If `Qwen3.8-27B` (or another model served under a Qwen name) is ever replaced by a build using the **official Qwen 3.8 template** — the one that throws on `enable_thinking: false` — instruct-mode requests will fail with a per-request template error (HTTP 500). Mitigations, in order of preference: serve a classic-template GGUF, serve with an explicit llama.cpp `--chat-template`, or accept the clamped (thinking-on) behavior for that model. The extension cannot detect the template type in advance; the failure is loud, not silent.
2. **Name-based gating.** The Qwen gate matches `/qwen/i` against the payload model id or the session model's id/name/provider. A hypothetical non-Qwen model with "qwen" in its id would be gated in (and its requests rewritten); a Qwen model served under a non-Qwen name would be missed. Both are unlikely with llama.cpp's exact model ids; the session-model fallback covers the latter case for models registered in `models.yml` with Qwen ids.
3. **Completions-wire top-level field.** The flip of top-level `enable_thinking` only happens when the field is already boolean; it is never injected. If a future runtime version stops sending it on the Completions wire, the kwarg still forces off (the kwarg is the primary force on both wires).

## 10. Reproducing the probe

Against a llama.cpp server hosting a classic-template Qwen GGUF, the decisive probe (R3) is a single request:

```http
POST /v1/responses
Content-Type: application/json

{
  "model": "Qwen3.8-27B",
  "input": "Reply with exactly: OK",
  "chat_template_kwargs": { "enable_thinking": false },
  "reasoning": { "effort": "low" }
}
```

Expected: HTTP 200, response `output` contains a `message` item and **no** `reasoning` item. If a `reasoning` item appears (or the request 500s with a template error), the served template does not match the classic one this feature relies on — see §9.1.

## 11. Open items

- None blocking. User-side acceptance: run a real omp session on the `instruct` profile and confirm zero thinking in the transcript (expected from probes + unit tests; the only unexercised path is the full runtime stack end-to-end).
- If the server catalog is ever switched to official-template Qwen 3.8 builds, revisit §9.1 — the fallbacks there are documented but not implemented (deliberately: the probe made them unnecessary for the current GGUF).
