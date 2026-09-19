/**
 * Smoke test for the qwen-mode-proxy profile store (pure logic only).
 * Run: bun test-smoke.ts
 * Hermetic: uses a temp XDG_CONFIG_HOME (set before any config access).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	validateParams,
	isValidName,
	parseJson,
	isTargetModel,
	isQwenModel,
	applyHardOff,
	loadConfig,
	saveConfig,
	getConfigPath,
	configExists,
	CONFIG_VERSION,
	toThinkingLevel,
	asOnLevel,
	clampedOffNote,
	planThinkingApply,
	shouldRememberLevel,
	DEFAULT_PROFILES,
	type ProfileDef,
} from "./extensions/config";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qmp-test-"));
process.env.XDG_CONFIG_HOME = tmp;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
	if (cond) {
		pass++;
		console.log(`PASS ${name}`);
	} else {
		fail++;
		console.log(`FAIL ${name}`);
	}
}

// ── loadConfig defaults ─────────────────────────────────────────────
{
	const cfg = loadConfig();
	check("defaults: 4 profiles", Object.keys(cfg.profiles).length === 4);
	check("defaults: current is thinking", cfg.current === "thinking");
	check("defaults: thinking flag on", cfg.profiles["thinking"].thinking === true);
	check("defaults: coding flag on", cfg.profiles["coding"].thinking === true);
	check("defaults: reasoning flag off", cfg.profiles["reasoning"].thinking === false);
	check("defaults: instruct flag off", cfg.profiles["instruct"].thinking === false);
	check(
		"defaults: all profiles have descriptions",
		Object.values(cfg.profiles).every((p) => typeof p.description === "string" && p.description.length > 0),
	);
}

// ── save / load round-trip (incl. thinking flag) ────────────────────
{
	const cfg = loadConfig();
	cfg.profiles["custom"] = {
		temperature: 0.3,
		top_p: 0.5,
		top_k: 40,
		min_p: 0.05,
		presence_penalty: 0.5,
		repetition_penalty: 1.1,
		thinking: false,
		description: "low-temperature chat",
	};
	cfg.current = "custom";
	saveConfig(cfg);
	check("roundtrip: file exists", configExists());
	const reloaded = loadConfig();
	check("roundtrip: custom kept", reloaded.profiles["custom"]?.temperature === 0.3);
	check("roundtrip: thinking flag kept", reloaded.profiles["custom"]?.thinking === false);
	check("roundtrip: description kept", reloaded.profiles["custom"]?.description === "low-temperature chat");
	check("roundtrip: current kept", reloaded.current === "custom");
}

// ── corrupt / empty file fallback ───────────────────────────────────
{
	fs.writeFileSync(getConfigPath(), "{not json", "utf8");
	const cfg = loadConfig();
	check("corrupt: falls back to defaults", Object.keys(cfg.profiles).length === 4);
	fs.writeFileSync(getConfigPath(), "", "utf8");
	const cfg2 = loadConfig();
	check("empty: falls back to defaults", cfg2.current === "thinking");
}

// ── v1 → v2 migration (pre-thinking-flag files) ────────────────────
{
	const v1 = {
		profiles: {
			thinking: { temperature: 1, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0, repetition_penalty: 1 },
			coding: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0, repetition_penalty: 1 },
			instruct: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 1.5, repetition_penalty: 1 },
			"my-custom": { temperature: 0.3, top_p: 0.5, top_k: 40, min_p: 0.05, presence_penalty: 0.5, repetition_penalty: 1.1 },
		},
		current: "thinking",
	};
	fs.writeFileSync(getConfigPath(), JSON.stringify(v1), "utf8");
	const mig = loadConfig();
	check("migrate: thinking flag seeded on", mig.profiles.thinking?.thinking === true);
	check("migrate: coding flag seeded on", mig.profiles.coding?.thinking === true);
	check("migrate: instruct flag seeded off", mig.profiles.instruct?.thinking === false);
	check("migrate: custom profile untouched", mig.profiles["my-custom"]?.thinking === undefined);
	check("migrate: version stamped", mig.version === CONFIG_VERSION);

	// Idempotent: saving the migrated config and reloading keeps the flags.
	saveConfig(mig);
	const mig2 = loadConfig();
	check("migrate: stable across save/reload", mig2.profiles.instruct?.thinking === false);

	// An explicit removal after migration must stick (no re-migration).
	delete mig2.profiles.coding.thinking;
	saveConfig(mig2);
	const mig3 = loadConfig();
	check("migrate: explicit removal kept", mig3.profiles.coding?.thinking === undefined);
}

// ── lastThinkingLevel persistence ──────────────────────────────────
{
	const cfg = loadConfig();
	check("lastLevel: missing by default", cfg.lastThinkingLevel === undefined);
	cfg.lastThinkingLevel = "high";
	saveConfig(cfg);
	const re = loadConfig();
	check("lastLevel: round-trip", re.lastThinkingLevel === "high");

	let bad: Record<string, unknown>;
	try {
		bad = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
	} catch {
		bad = {};
	}
	bad.lastThinkingLevel = "ultra";
	fs.writeFileSync(getConfigPath(), JSON.stringify(bad), "utf8");
	check("lastLevel: invalid value ignored", loadConfig().lastThinkingLevel === undefined);
}

// ── validateParams ──────────────────────────────────────────────────
{
	const base = {
		temperature: 0.7,
		top_p: 0.8,
		top_k: 20,
		min_p: 0.0,
		presence_penalty: 0.0,
		repetition_penalty: 1.0,
	};
	const ok = validateParams(base);
	check("validate: valid ok", ok.ok);
	if (ok.ok) check("validate: thinking omitted → undefined", ok.params.thinking === undefined);

	const noKey = validateParams({ ...base, top_k: undefined });
	check("validate: missing key errors", !noKey.ok);

	const badType = validateParams({ ...base, temperature: "hot" });
	check("validate: non-number errors", !badType.ok);

	const outOfRange = validateParams({ ...base, temperature: 3.0 });
	check("validate: out-of-range errors", !outOfRange.ok);

	const badInt = validateParams({ ...base, top_k: 12.5 });
	check("validate: non-integer top_k errors", !badInt.ok);

	const alias = validateParams({ ...base, repeat_penalty: 1.2, repetition_penalty: undefined });
	check("validate: alias-only ok", alias.ok);
	if (alias.ok) check("validate: alias mapped to repetition_penalty", alias.params.repetition_penalty === 1.2);
	const bothEqual = validateParams({ ...base, repeat_penalty: 1.0 });
	check("validate: both equal ok", bothEqual.ok);

	const bothDiff = validateParams({ ...base, repeat_penalty: 1.3 });
	check("validate: both differ errors", !bothDiff.ok);

	// thinking flag
	const tOn = validateParams({ ...base, thinking: true });
	check("validate: thinking true ok", tOn.ok);
	if (tOn.ok) check("validate: thinking true kept", tOn.params.thinking === true);

	const tOff = validateParams({ ...base, thinking: false });
	check("validate: thinking false ok", tOff.ok);
	if (tOff.ok) check("validate: thinking false kept", tOff.params.thinking === false);

	const tStr = validateParams({ ...base, thinking: "yes" });
	check("validate: thinking string errors", !tStr.ok);

	const tNum = validateParams({ ...base, thinking: 1 });
	check("validate: thinking number errors", !tNum.ok);

	// description field
	const dOk = validateParams({ ...base, description: "  my note  " });
	check("validate: description ok", dOk.ok);
	if (dOk.ok) check("validate: description trimmed and kept", dOk.params.description === "my note");

	const dBlank = validateParams({ ...base, description: "   " });
	check("validate: blank description ok", dBlank.ok);
	if (dBlank.ok) check("validate: blank description dropped", dBlank.params.description === undefined);

	const dNum = validateParams({ ...base, description: 42 });
	check("validate: non-string description errors", !dNum.ok);

	const unknown = validateParams({ ...base, surprise: 42 });
	check("validate: unknown key ignored", unknown.ok);
}

// ── isValidName / parseJson ─────────────────────────────────────────
{
	check("name: valid", isValidName("my-profile_2"));
	check("name: rejects uppercase", !isValidName("My"));
	check("name: rejects leading dash", !isValidName("-x"));
	const good = parseJson<{ a: number }>('{"a":1}');
	check("parseJson: ok", good.ok && good.value.a === 1);
	const bad = parseJson("nope");
	check("parseJson: error", !bad.ok);
}

// ── isTargetModel ───────────────────────────────────────────────────
{
	check("target: payload llama", isTargetModel({ model: "llamacpp" }, undefined));
	check("target: payload qwen", isTargetModel({ model: "qwen3.8-27b" }, undefined));
	check("target: provider llamacpp", isTargetModel({}, { provider: "llamacpp" }));
	check("target: provider llama.cpp", isTargetModel({}, { provider: "llama.cpp" }));
	check("target: name Qwen", isTargetModel({}, { name: "Qwen3-30B-A3B" }));
	check("target: non-target", !isTargetModel({ model: "gpt-4o" }, { provider: "openai" }));
	check("target: no payload/model", !isTargetModel(undefined, undefined));
	check("target: non-string model", !isTargetModel({ model: 42 }, undefined));
}

// ── thinking level helpers ──────────────────────────────────────────
{
	check("toThinkingLevel: valid level", toThinkingLevel("high") === "high");
	check("toThinkingLevel: off is a level", toThinkingLevel("off") === "off");
	check("toThinkingLevel: inherit is unknown", toThinkingLevel("inherit") === undefined);
	check("toThinkingLevel: garbage rejected", toThinkingLevel("bogus") === undefined);
	check("toThinkingLevel: non-string rejected", toThinkingLevel(3) === undefined);
	check("asOnLevel: on-level passes", asOnLevel("low") === "low");
	check("asOnLevel: off excluded", asOnLevel("off") === undefined);
	check("asOnLevel: inherit excluded", asOnLevel("inherit") === undefined);
}

// ── planThinkingApply ───────────────────────────────────────────────
{
	const on: ProfileDef = { ...DEFAULT_PROFILES.thinking };
	const off: ProfileDef = { ...DEFAULT_PROFILES.instruct };
	const plain: ProfileDef = { ...DEFAULT_PROFILES.instruct, thinking: undefined };

	check("plan: omitted flag → none", planThinkingApply(plain, "high", undefined) === "none");
	check("plan: on + already on (user-owned) → none", planThinkingApply(on, "high", undefined) === "none");
	check("plan: on + already on (we set it) → none", planThinkingApply(on, "xhigh", "xhigh") === "none");
	check("plan: on + session off (pi) → on", planThinkingApply(on, "off", undefined) === "on");
	check("plan: on + clamped minimum after our off (omp) → on", planThinkingApply(on, "low", "off") === "on");
	check("plan: on + unknown reported while off → on", planThinkingApply(on, "inherit", "off") === "on");
	check("plan: off + on → off", planThinkingApply(off, "high", undefined) === "off");
	check("plan: off + already off (pi) → off", planThinkingApply(off, "off", undefined) === "off");
	check("plan: off + clamped minimum → off (idempotent)", planThinkingApply(off, "low", "off") === "off");
	check("plan: omitted + off → none", planThinkingApply(plain, "off", "off") === "none");
}

// ── shouldRememberLevel ─────────────────────────────────────────────
{
	const on: ProfileDef = { ...DEFAULT_PROFILES.thinking };
	const off: ProfileDef = { ...DEFAULT_PROFILES.instruct };

	check("remember: our clamped off state (omp) skipped", shouldRememberLevel(off, "low", "off", "low") === false);
	check("remember: our off state (pi) skipped", shouldRememberLevel(off, "off", "off", "off") === false);
	check("remember: manual selection while off-profile → remembered", shouldRememberLevel(off, "xhigh", "off", "low") === true);
	check("remember: user minimum on off-profile (we didn't turn off) → remembered", shouldRememberLevel(off, "low", undefined, "off") === true);
	check("remember: on-level on thinking profile → remembered", shouldRememberLevel(on, "medium", "medium", "off") === true);
	check("remember: off never remembered", shouldRememberLevel(on, "off", undefined, "off") === false);
	check("remember: inherit never remembered", shouldRememberLevel(on, "inherit", undefined, "off") === false);
}

// ── clampedOffNote ──────────────────────────────────────────────────
{
	check("note: real off → no note", clampedOffNote("off", false) === undefined);
	check("note: real off → no note (hardOff)", clampedOffNote("off", true) === undefined);
	const note = clampedOffNote("low", false);
	check("note: clamped, no hard-off → explains minimum effort", note !== undefined && note.includes("low"));
	check("note: clamped, no hard-off → points at Ctrl+T", note !== undefined && note.includes("Ctrl+T"));
	const hard = clampedOffNote("low", true);
	check("note: clamped + hard-off → mentions enable_thinking:false", hard !== undefined && hard.includes("enable_thinking:false"));
	check("note: clamped + hard-off → reports the clamped level", hard !== undefined && hard.includes("low"));
}

// ── isQwenModel / applyHardOff ──────────────────────────────────────
{
	check("qwen: payload model matches", isQwenModel({ model: "Qwen3.8-27B" }, undefined) === true);
	check("qwen: session model matches", isQwenModel({}, { id: "qwen3-30b-a3b", provider: "llama.cpp" }) === true);
	check("qwen: non-qwen model rejected", isQwenModel({ model: "KAT-Coder-V2.5-Dev" }, { provider: "llama.cpp" }) === false);

	// Responses wire (omp): reasoning: { effort } is the clamped off.
	const responses: Record<string, unknown> = {
		model: "Qwen3.8-27B",
		input: "hi",
		stream: true,
		reasoning: { effort: "low" },
	};
	check("hardoff: responses wire rewritten", applyHardOff(responses, undefined) === true);
	check("hardoff: responses wire strips reasoning effort", responses.reasoning === undefined);
	check(
		"hardoff: responses wire forces enable_thinking:false",
		(responses.chat_template_kwargs as Record<string, unknown> | undefined)?.enable_thinking === false,
	);

	// Completions wire (pi): top-level enable_thinking + reasoning_effort.
	const completions: Record<string, unknown> = {
		model: "qwen3-30b-a3b",
		messages: [{ role: "user", content: "hi" }],
		enable_thinking: true,
		reasoning_effort: "low",
		chat_template_kwargs: { reasoning_effort: "low" },
	};
	check("hardoff: completions wire rewritten", applyHardOff(completions, undefined) === true);
	check("hardoff: completions wire strips top-level effort", completions.reasoning_effort === undefined);
	check("hardoff: completions wire flips enable_thinking", completions.enable_thinking === false);
	const ck = completions.chat_template_kwargs as Record<string, unknown>;
	check("hardoff: completions wire kwargs forced off", ck.enable_thinking === false && ck.reasoning_effort === undefined);

	// Existing kwargs are preserved.
	const merged: Record<string, unknown> = {
		model: "Qwen3.8-27B",
		chat_template_kwargs: { add_generation_prompt: true },
	};
	applyHardOff(merged, undefined);
	const mk = merged.chat_template_kwargs as Record<string, unknown>;
	check("hardoff: existing kwargs preserved", mk.add_generation_prompt === true && mk.enable_thinking === false);

	// Non-Qwen model: untouched.
	const other: Record<string, unknown> = {
		model: "KAT-Coder-V2.5-Dev",
		reasoning: { effort: "low" },
	};
	check("hardoff: non-qwen payload untouched", applyHardOff(other, { id: "llama.cpp" }) === false);
	check("hardoff: non-qwen keeps reasoning field", other.reasoning !== undefined);
	check("hardoff: non-qwen gets no kwargs", other.chat_template_kwargs === undefined);

	// Session model identity gates when the payload has no model field.
	const bySession: Record<string, unknown> = { reasoning: { effort: "low" } };
	check("hardoff: session model identity gates", applyHardOff(bySession, { id: "Qwen3.8-27B", provider: "llama.cpp" }) === true);

	// Idempotent.
	const once: Record<string, unknown> = { model: "qwen3.8-27b", reasoning: { effort: "low" } };
	applyHardOff(once, undefined);
	const snapshot = JSON.stringify(once);
	applyHardOff(once, undefined);
	check("hardoff: idempotent", JSON.stringify(once) === snapshot);
}

process.exit(fail === 0 ? 0 : 1);
