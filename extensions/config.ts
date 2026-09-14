/**
 * Qwen Mode Proxy — profile store
 *
 * Pure logic (no extension API): sampling-profile types, defaults,
 * JSON-file persistence, validation, and target-model matching.
 *
 * Profiles are persisted to:
 *   $XDG_CONFIG_HOME/qwen-mode-proxy/profiles.json
 *   (defaults to ~/.config/qwen-mode-proxy/profiles.json)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Types ───────────────────────────────────────────────────────────

/** Sampling parameters injected into the provider request payload. */
export interface ModeParams {
	/** Sampling temperature (0.0–2.0) */
	temperature: number;
	/** Nucleus sampling top_p (0.0–1.0) */
	top_p: number;
	/** Top-k sampling (0 = disabled, >0 = keep top k tokens) */
	top_k: number;
	/** Minimum P ratio (0.0–1.0, 0 = disabled) */
	min_p: number;
	/** Presence penalty (-2.0–2.0, rewards new topics) */
	presence_penalty: number;
	/** Repetition penalty (1.0 = disabled, >1.0 penalizes repeats) */
	repetition_penalty: number;
}

/**
 * A sampling profile: the six sampling parameters plus an optional
 * thinking override and an optional free-form description. When
 * `thinking` is set, the extension syncs pi's thinking level whenever
 * the profile becomes active: `true` turns thinking on (restoring the
 * user's last non-off level), `false` turns it off. Omitted → the
 * thinking level is left untouched. `description` is display-only
 * (profile list, picker, autocomplete) — never injected into requests.
 */
export interface ProfileDef extends ModeParams {
	thinking?: boolean;
	description?: string;
}

/** Persisted profile store: named profiles + the active one. */
export interface ProfileConfig {
	profiles: Record<string, ProfileDef>;
	current: string;
	/** Schema version of the persisted file. */
	version?: number;
	/** Last non-off thinking level, remembered across sessions. */
	lastThinkingLevel?: ThinkingLevel;
}

/**
 * Current schema version. Bump and add a migration step in
 * `loadConfig` when the file shape changes.
 * v2 (1 → 2): profiles gained the optional `thinking` flag.
 */
export const CONFIG_VERSION = 2;

/**
 * pi's thinking levels — mirrors `ThinkingLevel` from
 * @earendil-works/pi-agent-core (not re-exported from the pi-coding-agent
 * root). Kept in sync by the type-check at the `setThinkingLevel` /
 * `thinking_level_select` call sites.
 */
export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Coerce a persisted value to a valid thinking level, or undefined. */
function asThinkingLevel(value: unknown): ThinkingLevel | undefined {
	return typeof value === "string" &&
		(THINKING_LEVELS as readonly string[]).includes(value)
		? (value as ThinkingLevel)
		: undefined;
}

/** Structural view of the session model (pi `Model` satisfies this). */
export interface ModelIdentity {
	id?: string;
	name?: string;
	provider?: string;
}

// ── Defaults ────────────────────────────────────────────────────────

export const PARAM_KEYS: (keyof ModeParams)[] = [
	"temperature",
	"top_p",
	"top_k",
	"min_p",
	"presence_penalty",
	"repetition_penalty",
];

/**
 * Default profiles — seeded on first run.
 * Values from the unsloth sampling recommendations:
 * https://unsloth.ai/docs/models/qwen3.8 and
 * https://unsloth.ai/docs/models/qwen3.6
 */
export const DEFAULT_PROFILES: Record<string, ProfileDef> = {
	thinking: {
		temperature: 1.0,
		top_p: 0.95,
		top_k: 20,
		min_p: 0.0,
		presence_penalty: 0.0,
		repetition_penalty: 1.0,
		thinking: true,
		description: "Qwen3.8 thinking — creative, exploratory, maximises diversity",
	},
	coding: {
		temperature: 0.6,
		top_p: 0.95,
		top_k: 20,
		min_p: 0.0,
		presence_penalty: 0.0,
		repetition_penalty: 1.0,
		thinking: true,
		description: "Qwen3.6 Thinking Precise — precise, deterministic, low temperature",
	},
	instruct: {
		temperature: 0.7,
		top_p: 0.8,
		top_k: 20,
		min_p: 0.0,
		presence_penalty: 1.5,
		repetition_penalty: 1.0,
		thinking: false,
		description: "Qwen3.8 instruct / Qwen3.6 Instruct General — balanced, presence penalty for variety",
	},
	reasoning: {
		temperature: 1.0,
		top_p: 0.95,
		top_k: 20,
		min_p: 0.0,
		presence_penalty: 1.5,
		repetition_penalty: 1.0,
		thinking: false,
		description: "Qwen3.6 Instruct Reasoning / Thinking General — analytical, non-thinking",
	},
};

// ── Persistence ─────────────────────────────────────────────────────

/** Absolute path of the profiles file (XDG-aware). */
export function getConfigPath(): string {
	const base =
		process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
	return path.join(base, "qwen-mode-proxy", "profiles.json");
}

/** True when the profiles file already exists on disk. */
export function configExists(): boolean {
	try {
		return fs.existsSync(getConfigPath());
	} catch {
		return false;
	}
}

/**
 * Load the profile store. Pure read — never writes.
 * Falls back to the default profiles when the file is missing,
 * unreadable, malformed, or contains no valid profiles.
 */
export function loadConfig(): ProfileConfig {
	try {
		const raw = fs.readFileSync(getConfigPath(), "utf8");
		const parsed = JSON.parse(raw) as Partial<ProfileConfig>;

		const profiles: Record<string, ProfileDef> = {};
		if (parsed.profiles && typeof parsed.profiles === "object") {
			for (const [name, value] of Object.entries(parsed.profiles)) {
				const result = validateParams(value);
				if (result.ok) profiles[name] = result.params;
			}
		}
		if (Object.keys(profiles).length === 0) {
			return { profiles: { ...DEFAULT_PROFILES }, current: "thinking", version: CONFIG_VERSION };
		}
		// v1 → v2: seed the `thinking` flag on the default profiles that
		// predate it. One-shot — recorded via `version`, so later explicit
		// edits (including removing the flag) are never overwritten.
		if (parsed.version !== CONFIG_VERSION) {
			for (const [name, def] of Object.entries(DEFAULT_PROFILES)) {
				const existing = profiles[name];
				if (existing && typeof existing.thinking !== "boolean") {
					existing.thinking = def.thinking;
				}
			}
		}
		const current =
			typeof parsed.current === "string" && profiles[parsed.current]
				? parsed.current
				: Object.keys(profiles)[0];
		return { profiles, current, version: CONFIG_VERSION, lastThinkingLevel: asThinkingLevel(parsed.lastThinkingLevel) };
	} catch {
		return { profiles: { ...DEFAULT_PROFILES }, current: "thinking", version: CONFIG_VERSION };
	}
}

/** Write the profile store. Returns false (never throws) on failure. */
export function saveConfig(config: ProfileConfig): boolean {
	try {
		const file = getConfigPath();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n", "utf8");
		return true;
	} catch {
		return false;
	}
}

// ── Validation ──────────────────────────────────────────────────────

type ParamRange = { min: number; max: number; int?: boolean };

const PARAM_RANGES: Record<keyof ModeParams, ParamRange> = {
	temperature: { min: 0, max: 2 },
	top_p: { min: 0, max: 1 },
	top_k: { min: 0, max: 1_000_000, int: true },
	min_p: { min: 0, max: 1 },
	presence_penalty: { min: -2, max: 2 },
	repetition_penalty: { min: 1, max: 10 },
};

export type ValidationResult =
	| { ok: true; params: ProfileDef }
	| { ok: false; error: string };

/**
 * Validate a candidate parameter object. All six parameters are
 * required; unknown extra keys are ignored.
 *
 * `repeat_penalty` is accepted as an alias for `repetition_penalty`
 * (llama.cpp's name for the same parameter — unsloth's preset dicts
 * carry both). When both are present they must agree.
 *
 * An optional `thinking` boolean (syncs pi's thinking level when the
 * profile is active) is preserved; if present it must be a boolean.
 *
 * An optional `description` string (shown in the profile list and
 * picker) is preserved; if present it must be a string. Blank
 * descriptions are dropped.
 */
export function validateParams(input: unknown): ValidationResult {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return { ok: false, error: "profile must be a JSON object of parameters" };
	}
	const obj = input as Record<string, unknown>;
	const canonical = obj["repetition_penalty"];
	const alias = obj["repeat_penalty"];
	if (
		canonical !== undefined &&
		alias !== undefined &&
		typeof canonical === "number" &&
		typeof alias === "number" &&
		canonical !== alias
	) {
		return {
			ok: false,
			error: `"repetition_penalty" (${canonical}) and "repeat_penalty" (${alias}) differ — use one`,
		};
	}
	if (canonical === undefined) obj["repetition_penalty"] = alias;
	const params: ProfileDef = {
		temperature: 0,
		top_p: 0,
		top_k: 0,
		min_p: 0,
		presence_penalty: 0,
		repetition_penalty: 0,
	};
	for (const key of PARAM_KEYS) {
		const value = obj[key];
		if (typeof value !== "number" || !Number.isFinite(value)) {
			return {
				ok: false,
				error: `"${key}" must be a number (got ${JSON.stringify(value)})`,
			};
		}
		const range = PARAM_RANGES[key];
		if (range.int && !Number.isInteger(value)) {
			return { ok: false, error: `"${key}" must be an integer (got ${value})` };
		}
		if (value < range.min || value > range.max) {
			return {
				ok: false,
				error: `"${key}" must be between ${range.min} and ${range.max} (got ${value})`,
			};
		}
		params[key] = value;
	}
	if ("thinking" in obj) {
		if (typeof obj["thinking"] !== "boolean") {
			return {
				ok: false,
				error: `"thinking" must be a boolean (got ${JSON.stringify(obj["thinking"])})`,
			};
		}
		params.thinking = obj["thinking"];
	}

	if ("description" in obj) {
		const description = obj["description"];
		if (typeof description !== "string") {
			return {
				ok: false,
				error: `"description" must be a string (got ${JSON.stringify(description)})`,
			};
		}
		const trimmed = description.trim();
		if (trimmed) params.description = trimmed;
	}
	return { ok: true, params };
}

/** Profile names: lowercase, start with letter/digit, then [a-z0-9_-]. */
export function isValidName(name: string): boolean {
	return /^[a-z0-9][a-z0-9_-]*$/.test(name);
}

/** Safe JSON parse for user-edited text. */
export function parseJson<T>(text: string): { ok: true; value: T } | { ok: false; error: string } {
	try {
		return { ok: true, value: JSON.parse(text) as T };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

// ── Target model matching ───────────────────────────────────────────

/**
 * Matches any model or provider whose id/name contains "llama" or
 * "qwen" (case-insensitive) — e.g. provider `llamacpp`, model
 * `qwen3.8-27b`, provider `llama.cpp`, model `Qwen3-30B-A3B`.
 */
const TARGET_PATTERN = /llama|qwen/i;

/**
 * Decide whether sampling parameters should be injected for this
 * request. Checks the request payload's `model` field plus the live
 * session model's id/name/provider.
 */
export function isTargetModel(
	payload: unknown,
	model: ModelIdentity | undefined,
): boolean {
	const candidates: string[] = [];
	if (payload && typeof payload === "object") {
		const m = (payload as Record<string, unknown>).model;
		if (typeof m === "string") candidates.push(m);
	}
	if (model) {
		if (typeof model.id === "string") candidates.push(model.id);
		if (typeof model.name === "string") candidates.push(model.name);
		if (typeof model.provider === "string") candidates.push(model.provider);
	}
	return candidates.some((s) => TARGET_PATTERN.test(s));
}
