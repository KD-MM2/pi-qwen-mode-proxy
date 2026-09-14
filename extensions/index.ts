/**
 * Qwen Mode Proxy Extension
 *
 * Intercepts OpenAI-completions API requests to the llama.cpp provider
 * and injects profile-specific sampling parameters (temperature, top_p,
 * top_k, min_p, presence_penalty, repetition_penalty) corresponding to
 * the active profile.
 *
 * Profiles are user-managed (add / edit / delete / switch) and persisted
 * to ~/.config/qwen-mode-proxy/profiles.json. Four defaults are seeded
 * on first run: thinking, reasoning, coding, instruct.
 *
 * Parameters are injected only for requests whose model or provider
 * name contains "llama" or "qwen" (case-insensitive).
 *
 * Default profiles:
 * - thinking — Creative, exploratory tasks. Higher temperature for diverse output.
 * - coding   — Precise, deterministic coding tasks. Lower temperature for consistent results.
 * - instruct — Instruction-following with presence penalty to encourage topic variety.
 *
 * Profiles may set "thinking": true|false. When a profile becomes active,
 * the extension syncs pi's thinking level: true turns thinking on (restoring
 * the user's last non-off level), false turns it off. pi-llama-cpp then
 * bridges that level to the server (enable_thinking / thinking_budget_tokens).
 *
 * Commands:
 * - /mode              — Show current profile + list all profiles
 * - /mode <name>       — Switch to profile <name>
 * - /mode list         — Show all profiles with their parameters
 * - /mode new [name]   — Create a new profile (prefilled from the active one)
 * - /mode edit <name>  — Edit a profile's sampling parameters
 * - /mode delete <name>— Delete a profile
 *
 * Usage:
 * Placed in ~/.pi/agent/extensions/qwen-mode-proxy/index.ts
 * Auto-discovered by pi. Reload with /reload.
 *
 * Model name: "llamacpp"
 * Matches any model or provider whose id/name contains "llama" or "qwen".
 *
 * @module
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getConfigPath,
	configExists,
	loadConfig,
	saveConfig,
	isTargetModel,
	isValidName,
	parseJson,
	validateParams,
	PARAM_KEYS,
	DEFAULT_PROFILES,
	type ModeParams,
	type ProfileDef,
	type ThinkingLevel,
	type ProfileConfig,
} from "./config";

const STATUS_KEY = "qwen-mode";
const SUBCOMMANDS = ["list", "new", "edit", "delete"];

// ── Helpers ─────────────────────────────────────────────────────────

function paramsSummary(p: ProfileDef): string {
	const think = p.thinking === true ? "think:on" : p.thinking === false ? "think:off" : "think:-";
	return (
		`temp=${p.temperature} top_p=${p.top_p} top_k=${p.top_k} ` +
		`min_p=${p.min_p} pres=${p.presence_penalty} rep=${p.repetition_penalty} ${think}`
	);
}

function paramsToTemplate(p: ProfileDef): string {
	return JSON.stringify(p, null, 2);
}

/** Render the profile list as widget lines (capped to fit the 10-line widget). */
function renderProfileList(config: ProfileConfig): string[] {
	const names = Object.keys(config.profiles);
	const lines: string[] = [`🎛 Qwen profiles — active: ${config.current}`];
	const maxShown = 3;
	for (const name of names.slice(0, maxShown)) {
		const def = config.profiles[name];
		const marker = name === config.current ? "●" : "○";
		const desc = def.description;
		const shown = desc && desc.length > 60 ? `${desc.slice(0, 59)}…` : desc;
		lines.push(shown ? `${marker} ${name} — ${shown}` : `${marker} ${name}`);
		lines.push(`  ${paramsSummary(def)}`);
	}
	if (names.length > maxShown) {
		lines.push(`… +${names.length - maxShown} more`);
	}
	lines.push(`${getConfigPath()}`);
	lines.push("/mode <name> · new [name] · edit <name> · delete <name>");
	return lines.slice(0, 10);
}

// ── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let config: ProfileConfig | null = null;
	// Last non-off thinking level the user selected; restored when a
	// thinking profile is activated while thinking is off. Persisted in
	// the config file so it survives across sessions.
	let lastOnLevel: ThinkingLevel = "medium";

	function ensureConfig(): ProfileConfig {
		if (!config) config = loadConfig();
		return config;
	}

	function activeParams(): ProfileDef {
		const cfg = ensureConfig();
		return cfg.profiles[cfg.current] ?? DEFAULT_PROFILES.thinking;
	}

	function updateUi(ctx: ExtensionContext): void {
		const cfg = ensureConfig();
		const active = cfg.profiles[cfg.current] ?? DEFAULT_PROFILES.thinking;
		const think = active.thinking === true ? " 🧠" : active.thinking === false ? " 🧠off" : "";
		ctx.ui.setStatus(STATUS_KEY, `🎛 ${cfg.current}${think}`);
	}

	/**
	 * Sync pi's thinking level with the profile's `thinking` flag.
	 * `true` only turns thinking on when it is off (restoring the user's
	 * last non-off level); `false` only turns it off. Omitted → untouched.
	 * Pi clamps the requested level to the active model's capabilities, so
	 * the effective level is read back and remembered.
	 */
	function applyThinking(profile: ProfileDef): void {
		if (typeof profile.thinking !== "boolean") return;
		const level = pi.getThinkingLevel();
		if (profile.thinking) {
			if (level !== "off") return;
			pi.setThinkingLevel(lastOnLevel);
			const effective = pi.getThinkingLevel();
			if (effective !== "off") lastOnLevel = effective;
		} else if (level !== "off") {
			pi.setThinkingLevel("off");
		}
	}

	function persist(ctx: ExtensionContext): void {
		const cfg = ensureConfig();
		updateUi(ctx);
		if (!saveConfig(cfg)) {
			ctx.ui.notify(
				`⚠️ Saved in memory, but could not write ${getConfigPath()}`,
				"warning",
			);
		}
	}

	function showList(ctx: ExtensionContext): void {
		ctx.ui.setWidget("qwen-mode-list", renderProfileList(ensureConfig()));
		ctx.ui.notify(`🎛 Profile: ${ensureConfig().current}`, "info");
	}

	async function pickProfile(ctx: ExtensionContext): Promise<string | undefined> {
		const cfg = ensureConfig();
		const names = Object.keys(cfg.profiles);
		if (names.length === 0) return undefined;
		const options = names.map((n) => {
			const desc = cfg.profiles[n].description;
			return desc ? `${n} — ${desc}` : n;
		});
		const picked = await ctx.ui.select("Select a profile", options);
		// Profile names never contain " — " (isValidName), so the first
		// segment of the option string is the name.
		return picked?.split(" — ")[0];
	}

	/**
	 * Open the parameter editor for a profile. Returns the validated
	 * params on success, or undefined when cancelled/invalid.
	 */
	async function editParams(
		ctx: ExtensionContext,
		name: string,
		existing: ProfileDef,
	): Promise<ProfileDef | undefined> {
		if (!ctx.hasUI) {
			ctx.ui.notify("Profile editing needs an interactive UI", "error");
			return undefined;
		}
		const edited = await ctx.ui.editor(
			`Profile "${name}" — edit the sampling parameters (JSON). Optional "thinking": true|false syncs pi's thinking level; optional "description" is shown in the profile list:`,
			paramsToTemplate(existing),
		);
		if (edited === undefined) {
			ctx.ui.notify("Cancelled", "info");
			return undefined;
		}
		const parsed = parseJson<unknown>(edited);
		if (!parsed.ok) {
			ctx.ui.notify(`❌ Invalid JSON: ${parsed.error}`, "error");
			return undefined;
		}
		const result = validateParams(parsed.value);
		if (!result.ok) {
			ctx.ui.notify(`❌ ${result.error}`, "error");
			return undefined;
		}
		return result.params;
	}

	async function createProfile(ctx: ExtensionContext, argName?: string): Promise<void> {
		const cfg = ensureConfig();
		let name = (argName ?? "").trim().toLowerCase();
		if (!name) {
			if (!ctx.hasUI) {
				ctx.ui.notify("Usage: /mode new <name>", "error");
				return;
			}
			const typed = await ctx.ui.input("New profile name", "my-profile");
			if (!typed) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
			name = typed.trim().toLowerCase();
		}
		if (!isValidName(name)) {
			ctx.ui.notify(
				`❌ Invalid name "${name}" — use lowercase letters, digits, - or _ (must start with a letter or digit)`,
				"error",
			);
			return;
		}
		if (cfg.profiles[name]) {
			ctx.ui.notify(`⚠️ Profile "${name}" already exists — use /mode edit ${name}`, "warning");
			return;
		}
		const params = await editParams(ctx, name, cfg.profiles[cfg.current] ?? DEFAULT_PROFILES.thinking);
		if (!params) return;
		cfg.profiles[name] = params;
		cfg.current = name;
		applyThinking(params);
		persist(ctx);
		ctx.ui.notify(`✅ Created profile "${name}" and switched to it`, "info");
	}

	async function editProfile(ctx: ExtensionContext, argName?: string): Promise<void> {
		const cfg = ensureConfig();
		let name = (argName ?? "").trim().toLowerCase();
		if (!name) {
			const picked = await pickProfile(ctx);
			if (!picked) return;
			name = picked;
		}
		if (!cfg.profiles[name]) {
			ctx.ui.notify(`❌ Unknown profile "${name}" — use /mode to list profiles`, "error");
			return;
		}
		const params = await editParams(ctx, name, cfg.profiles[name]);
		if (!params) return;
		cfg.profiles[name] = params;
		if (cfg.current === name) applyThinking(params);
		persist(ctx);
		ctx.ui.notify(`✅ Updated profile "${name}"`, "info");
	}

	async function deleteProfile(ctx: ExtensionContext, argName?: string): Promise<void> {
		const cfg = ensureConfig();
		let name = (argName ?? "").trim().toLowerCase();
		if (!name) {
			const picked = await pickProfile(ctx);
			if (!picked) return;
			name = picked;
		}
		if (!cfg.profiles[name]) {
			ctx.ui.notify(`❌ Unknown profile "${name}"`, "error");
			return;
		}
		if (Object.keys(cfg.profiles).length <= 1) {
			ctx.ui.notify("❌ Cannot delete the last remaining profile", "error");
			return;
		}
		const confirmed = await ctx.ui.confirm(
			`Delete profile "${name}"?`,
			`Removes it from ${getConfigPath()}`,
		);
		if (!confirmed) {
			ctx.ui.notify("Cancelled", "info");
			return;
		}
		delete cfg.profiles[name];
		if (cfg.current === name) cfg.current = Object.keys(cfg.profiles)[0];
		applyThinking(cfg.profiles[cfg.current]);
		persist(ctx);
		ctx.ui.notify(`🗑 Deleted profile "${name}" — now on "${cfg.current}"`, "info");
	}

	function switchProfile(ctx: ExtensionContext, name: string): void {
		const cfg = ensureConfig();
		const key = name.trim().toLowerCase();
		if (!cfg.profiles[key]) {
			ctx.ui.notify(`❌ Unknown profile "${key}" — use /mode to list profiles`, "error");
			return;
		}
		cfg.current = key;
		applyThinking(cfg.profiles[key]);
		persist(ctx);
		ctx.ui.notify(`🎛 Profile: ${key}`, "info");
	}

	// ── Events ────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig();
		// Materialize the file on first run so users can find/edit it.
		if (!configExists()) saveConfig(config);
		// Restore the remembered level; a resumed session may already have
		// restored one from pi's session history — prefer that (fresher).
		const restored = pi.getThinkingLevel();
		lastOnLevel =
			restored !== "off" ? restored : config.lastThinkingLevel ?? "medium";
		applyThinking(config.profiles[config.current] ?? DEFAULT_PROFILES.thinking);
		updateUi(ctx);
	});

	// Safety net: persist any in-memory changes on shutdown.
	pi.on("session_shutdown", async () => {
		if (config) saveConfig(config);
	});

	// Intercepts the outgoing provider request and injects the active
	// profile's parameters when the target model matches.
	pi.on("before_provider_request", (event, ctx) => {
		if (!isTargetModel(event.payload, ctx.model)) return;
		const params = activeParams();
		const payload = event.payload as Record<string, unknown>;
		for (const key of PARAM_KEYS) {
			payload[key] = params[key];
		}
		// Raw llama.cpp API endpoints read `repeat_penalty`;
		// OpenAI-compatible servers read `repetition_penalty`.
		// Send both — each server ignores the other.
		payload.repeat_penalty = params.repetition_penalty;
		return payload;
	});

	// Refresh the status bar when the model changes.
	pi.on("model_select", async (_event, ctx) => {
		updateUi(ctx);
	});

	// Remember the user's preferred thinking level so profiles with
	// thinking: true can restore it. Persisted across sessions via the
	// config file. (No-op in runtimes without this event.)
	pi.on("thinking_level_select", (event) => {
		if (event.level === "off") return;
		lastOnLevel = event.level;
		if (config) {
			config.lastThinkingLevel = lastOnLevel;
			saveConfig(config);
		}
	});

	// ── Commands ──────────────────────────────────────────────────────

	pi.registerCommand("mode", {
		description:
			"Qwen sampling profiles: /mode [list|new [name]|edit <name>|delete <name>|<profile>]",
		getArgumentCompletions: (prefix) => {
			const p = prefix.toLowerCase();
			const profiles = ensureConfig().profiles;
			const items = [
				...SUBCOMMANDS.filter((s) => s.startsWith(p)).map((s) => ({
					value: s,
					label: s,
					description: "subcommand",
				})),
				...Object.keys(profiles)
					.filter((n) => n.startsWith(p))
					.map((n) => ({
						value: n,
						label: n,
						description: profiles[n].description ?? "switch to profile",
					})),
			];
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const sub = parts[0]?.toLowerCase();

			if (!sub) {
				showList(ctx);
				return;
			}
			if (sub === "list") {
				showList(ctx);
				return;
			}
			if (sub === "new") {
				await createProfile(ctx, parts[1]);
				return;
			}
			if (sub === "edit") {
				await editProfile(ctx, parts[1]);
				return;
			}
			if (sub === "delete" || sub === "del" || sub === "rm") {
				await deleteProfile(ctx, parts[1]);
				return;
			}
			switchProfile(ctx, sub);
		},
	});
}
