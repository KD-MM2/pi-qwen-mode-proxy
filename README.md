# pi-qwen-mode-proxy

Sampling profile proxy for Qwen/llama.cpp models served via an OpenAI-compatible endpoint (tested with Qwen 3.8 27B on llama.cpp).

Instead of a fixed set of modes, you manage your own **sampling profiles** — named sets of the six sampling parameters (`temperature`, `top_p`, `top_k`, `min_p`, `presence_penalty`, `repetition_penalty`) plus an optional `thinking` flag that syncs pi's thinking level and an optional free-form `description` shown in the profile list and picker. The active profile is injected into every OpenAI-completions request to a matching model.

## Default profiles

Seeded on first run (from the [unsloth Qwen3.8](https://unsloth.ai/docs/models/qwen3.8) / [Qwen3.6](https://unsloth.ai/docs/models/qwen3.6) sampling recommendations):

| Parameter | Thinking | Reasoning | Coding | Instruct |
| ----------- | ---------- | ----------- | -------- | ---------- |
| temperature | 1.0 | 1.0 | 0.6 | 0.7 |
| top_p | 0.95 | 0.95 | 0.95 | 0.80 |
| top_k | 20 | 20 | 20 | 20 |
| min_p | 0.0 | 0.0 | 0.0 | 0.0 |
| presence_penalty | 0.0 | 1.5 | 0.0 | 1.5 |
| repetition_penalty | 1.0 | 1.0 | 1.0 | 1.0 |
| pi thinking level | on | off | on | off |

- **thinking** — Qwen3.8 thinking mode. Creative, exploratory tasks; higher temperature for diverse output.
- **reasoning** — Qwen3.6 Instruct Reasoning / Thinking General. Analytical, non-thinking tasks; presence penalty for variety.
- **coding** — Qwen3.6 Thinking Precise. Precise, deterministic code generation; lower temperature.
- **instruct** — Qwen3.8 instruct / Qwen3.6 Instruct General. Instruction following with presence penalty for topic variety.

### Thinking control

Each profile may set `"thinking": true|false`. When a profile becomes active (session start, switch, create, edit, or delete), the extension syncs the runtime's thinking level:

- `true` — ensures thinking is **on**: if it is off (or this extension turned it off), the user's last non-off level is restored (remembered across sessions, default `medium`). If thinking is already on and the extension did not turn it off, the current level is left alone.
- `false` — turns thinking **off**.
- omitted — the thinking level is left untouched.

Works on both runtimes, which handle "off" differently:

- **pi** — thinking can be truly switched off; user selections arrive via the `thinking_level_select` event.
- **omp** — on models that cannot fully disable thinking (requiresEffort models), "off" is clamped to the model's *minimum effort*. The extension tracks the state it applied itself, so switching back to a thinking profile still restores the remembered level. omp fires no thinking-level events, so the extension samples the live level on every request — manual level selections in the omp UI are remembered automatically.

### True off for Qwen models

The clamped "off" would still re-enable minimum-effort thinking, because the payload keeps carrying an effort field. For **Qwen models** with a `thinking: false` profile, the extension therefore forces true off on the wire: it strips the effort carriers (`reasoning: { effort }` on the Responses API, `reasoning_effort` on Completions, and `reasoning_effort` inside `chat_template_kwargs`) and sets `enable_thinking: false` in `chat_template_kwargs`. The Qwen3-style llama.cpp chat template maps that to `/no_think` — **zero thinking tokens**, verified live against a Qwen3.8-27B GGUF on both `/v1/responses` and `/v1/chat/completions` (the kwarg wins even when a clamped effort is still present).

Whether that works depends on the template embedded in the GGUF: the classic Qwen3 template honors `enable_thinking: false`; a newer official 3.8 template instead steers depth via `reasoning_effort` and rejects the flag (the model catalog flags it as such). On such a build an instruct-mode request would fail with a template error — serve the model with a classic-template GGUF or a custom `--chat-template` if that happens.

On clamped **non-Qwen** models the assistant still emits a little reasoning at minimum effort, so thinking blocks can stay visible: runtimes auto-hide thinking blocks while the level is off, but only until the session has first produced displayable thinking content. If a session has already shown thinking (for example after using a thinking profile), press **Ctrl+T** to hide the blocks — it toggles the persisted `hideThinkingBlock` setting and works in both runtimes. The switch notification says so when "off" was clamped. This is the same class of limitation as [oh-my-pi#626](https://github.com/can1357/oh-my-pi/issues/626) (MiniMax, GLM, DeepSeek).

The remembered level is persisted in the config file (`lastThinkingLevel`). The runtime clamps requested levels to the model's capabilities and the extension reads the effective level back and remembers it. In pi, pi-llama-cpp bridges the level to the server (`enable_thinking`, `thinking_budget_tokens`); in omp, the level is encoded into the payload natively (`reasoning_effort` / `chat_template_kwargs` for Qwen). The status bar shows a 🧠 marker when the active profile sets thinking on (🧠off when off).

## Commands

| Command | Description |
| --------- | ------------- |
| `/mode` | Show the active profile and list all profiles |
| `/mode <name>` | Switch to profile `<name>` |
| `/mode list` | List all profiles with their parameters and descriptions |
| `/mode new <name>` | Create a profile (JSON editor opens, pre-filled from the active profile) |
| `/mode edit [name]` | Edit a profile (JSON editor) |
| `/mode delete <name>` | Delete a profile (with confirmation) |

The status bar shows the active profile (e.g. `Qwen: coding`) plus a 🧠 marker when its thinking flag is set.

## Installation

### npm

```bash
pi install npm:pi-qwen-mode-proxy
```

### git

```bash
pi install git:github.com/YOUR_USERNAME/pi-qwen-mode-proxy
```

### local

```bash
pi install /path/to/pi-qwen-mode-proxy
```

### omp

```bash
omp install npm:pi-qwen-mode-proxy
```

or `omp install /path/to/pi-qwen-mode-proxy` for a local install.

The package declares both `pi.extensions` and `omp.extensions` manifests, so it works in **pi** and **oh-my-pi (omp)** alike.

## Configuration

Profiles are stored in `~/.config/qwen-mode-proxy/profiles.json` (or `$XDG_CONFIG_HOME/qwen-mode-proxy/profiles.json`):

```json
{
  "profiles": {
    "thinking": { "temperature": 1.0, "top_p": 0.95, "top_k": 20, "min_p": 0.0, "presence_penalty": 0.0, "repetition_penalty": 1.0, "thinking": true },
    "my-profile": { "temperature": 0.3, "top_p": 0.5, "top_k": 40, "min_p": 0.05, "presence_penalty": 0.5, "repetition_penalty": 1.1, "thinking": false, "description": "low-temperature chat" }
  },
  "current": "coding",
  "lastThinkingLevel": "high"
}
```

The file is created on first run; you can also hand-edit it while pi/omp is not running. `lastThinkingLevel` is maintained automatically by the extension — hand-editing it is possible but it will be overwritten the next time you change the thinking level.

Profile JSON also accepts `repeat_penalty` as an alias for `repetition_penalty` (llama.cpp's name for the same parameter, used by unsloth's preset dicts). The injected payload carries both names, so OpenAI-compatible and raw llama.cpp endpoints both pick it up.

Profiles may also carry an optional `description` — free-form text shown in the `/mode` list, the profile picker, and command autocomplete. It is display-only and never injected into requests.

### Model matching

Parameters are injected only when the request targets a model whose ID or provider/name matches `/llama|qwen/i` (checked against the payload's `model` field and the selected model's `id`/`name`/`provider`). Other models pass through untouched.

## How It Works

The extension hooks into pi's `before_provider_request` event, which fires when pi builds the OpenAI request payload (chat completions or responses) but before it's sent over the network. When the target model matches, the handler injects the six sampling parameters of the active profile (plus `repeat_penalty`, llama.cpp's alias for `repetition_penalty`). For `thinking: false` profiles on Qwen models it additionally forces true off on the wire (see [True off for Qwen models](#true-off-for-qwen-models)): it strips the clamped effort fields and sets `chat_template_kwargs.enable_thinking: false`.

It also syncs the session's thinking level with the active profile's `thinking` flag: the user's selections (the `thinking_level_select` event in pi) and the live level sampled on every request (both runtimes) are remembered, and `pi.setThinkingLevel()` is called whenever the flag changes the effective state — including cases where the runtime clamps "off" to the minimum effort (omp on requiresEffort models).

No custom provider or streaming implementation is needed — the extension works as a lightweight interceptor on top of pi's built-in `openai-completions` provider.

## License

MIT
