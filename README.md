# pi-qwen-mode-proxy

Sampling profile proxy for Qwen/llama.cpp models served via an OpenAI-compatible endpoint (tested with Qwen 3.8 27B on llama.cpp).

Instead of a fixed set of modes, you manage your own **sampling profiles** — named sets of the six sampling parameters (`temperature`, `top_p`, `top_k`, `min_p`, `presence_penalty`, `repetition_penalty`) plus an optional `thinking` flag that syncs pi's thinking level. The active profile is injected into every OpenAI-completions request to a matching model.

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

Each profile may set `"thinking": true|false`. When a profile becomes active (session start, switch, create, edit, or delete), the extension syncs pi's thinking level:

- `true` — turns thinking **on** only if it is currently off, restoring your last non-off level (remembered across sessions, default `medium`).
- `false` — turns thinking **off**.
- omitted — the thinking level is left untouched.

pi clamps the requested level to the active model's capabilities, and the extension reads the effective level back and remembers it as your "last non-off level". That level is persisted in the config file (`lastThinkingLevel`), so it survives restarts: any time you change the level (via `/thinking` or the model picker), the new value is saved, and a new session with thinking off restores it when a `thinking: true` profile is active. pi-llama-cpp then bridges pi's thinking level to the server (`enable_thinking` on, `thinking_budget_tokens` per level) in the OpenAI-completions payload. The status bar shows a 🧠 marker when the active profile sets thinking on (🧠off when off).

## Commands

| Command | Description |
| --------- | ------------- |
| `/mode` | Show the active profile and list all profiles |
| `/mode <name>` | Switch to profile `<name>` |
| `/mode list` | List all profiles |
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

The package declares both `pi.extensions` and `omp.extensions` manifests, so it works in **pi** and **oh-my-pi (omp)** alike.

## Configuration

Profiles are stored in `~/.config/qwen-mode-proxy/profiles.json` (or `$XDG_CONFIG_HOME/qwen-mode-proxy/profiles.json`):

```json
{
  "profiles": {
    "thinking": { "temperature": 1.0, "top_p": 0.95, "top_k": 20, "min_p": 0.0, "presence_penalty": 0.0, "repetition_penalty": 1.0, "thinking": true },
    "my-profile": { "temperature": 0.3, "top_p": 0.5, "top_k": 40, "min_p": 0.05, "presence_penalty": 0.5, "repetition_penalty": 1.1, "thinking": false }
  },
  "current": "coding",
  "lastThinkingLevel": "high"
}
```

The file is created on first run; you can also hand-edit it while pi/omp is not running. `lastThinkingLevel` is maintained automatically by the extension — hand-editing it is possible but it will be overwritten the next time you change the thinking level.

Profile JSON also accepts `repeat_penalty` as an alias for `repetition_penalty` (llama.cpp's name for the same parameter, used by unsloth's preset dicts). The injected payload carries both names, so OpenAI-compatible and raw llama.cpp endpoints both pick it up.

### Model matching

Parameters are injected only when the request targets a model whose ID or provider/name matches `/llama|qwen/i` (checked against the payload's `model` field and the selected model's `id`/`name`/`provider`). Other models pass through untouched.

## How It Works

The extension hooks into pi's `before_provider_request` event, which fires when pi builds the OpenAI chat completions payload but before it's sent over the network. When the target model matches, the handler injects the six sampling parameters of the active profile (plus `repeat_penalty`, llama.cpp's alias for `repetition_penalty`).

It also listens for `thinking_level_select` to remember your preferred thinking level, and calls `pi.setThinkingLevel()` whenever the active profile's `thinking` flag changes the effective state.

No custom provider or streaming implementation is needed — the extension works as a lightweight interceptor on top of pi's built-in `openai-completions` provider.

## License

MIT
