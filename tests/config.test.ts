import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { harness, lines, row, tagTheme } from "./helpers.ts";

// pi reads user config from PI_CODING_AGENT_DIR; point it at a temp folder so
// these tests never see the real ~/.pi/agent.
const root = mkdtempSync(join(tmpdir(), "compact-transcript-config-"));
const agentDir = join(root, "agent");
const projectDir = join(root, "project");
mkdirSync(agentDir);
mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(root, { recursive: true, force: true });
});

const userConfig = join(agentDir, "compact-transcript.json");
const projectConfig = join(projectDir, CONFIG_DIR_NAME, "compact-transcript.json");

function writeConfigs({ user, project }: { user?: unknown; project?: unknown }) {
	rmSync(userConfig, { force: true });
	rmSync(projectConfig, { force: true });
	if (user !== undefined) writeFileSync(userConfig, typeof user === "string" ? user : JSON.stringify(user));
	if (project !== undefined) writeFileSync(projectConfig, typeof project === "string" ? project : JSON.stringify(project));
}

/** Starts a session and reports the resulting config through the extension's own behavior. */
async function resolvedConfig({ trusted = true, branch = [] as unknown[] } = {}) {
	const h = harness({ theme: tagTheme, trusted, cwd: projectDir });
	h.setBranch(branch);
	await h.startSession();
	await h.command("status");
	const enabled = h.notifications.at(-1)?.message === "Compact transcript: on";
	const summary = h.renderSummary({ reads: 2 });
	const summaryStyle = summary === undefined ? "off" : summary instanceof Markdown ? "quote" : summary instanceof Text ? "plain" : "?";
	await h.emit("agent_start");
	const tool = await h.start("probe", "read", { path: "a.ts" });
	await h.finish("probe");
	const highlightToolActions = enabled ? row(tool).includes("<toolDiffContext>") : undefined;
	await h.emit("session_shutdown");
	return { enabled, summaryStyle, highlightToolActions };
}

test("defaults apply without config files", async () => {
	writeConfigs({});
	assert.deepEqual(await resolvedConfig(), { enabled: true, summaryStyle: "plain", highlightToolActions: false });
});

test("user config overrides the defaults", async () => {
	writeConfigs({ user: { summaryStyle: "quote", highlightToolActions: true } });
	assert.deepEqual(await resolvedConfig(), { enabled: true, summaryStyle: "quote", highlightToolActions: true });
});

test("trusted project config overrides user config, key by key", async () => {
	writeConfigs({ user: { summaryStyle: "quote", highlightToolActions: true }, project: { summaryStyle: "off" } });
	assert.deepEqual(await resolvedConfig(), { enabled: true, summaryStyle: "off", highlightToolActions: true });
});

test("project config is ignored until the project is trusted", async () => {
	writeConfigs({ user: { summaryStyle: "quote" }, project: { enabled: false, summaryStyle: "off" } });
	assert.deepEqual(await resolvedConfig({ trusted: false }), {
		enabled: true,
		summaryStyle: "quote",
		highlightToolActions: false,
	});
});

test("the session's /compact-transcript toggle overrides config files", async () => {
	writeConfigs({ user: { enabled: true }, project: { enabled: true } });
	const branch = [{ type: "custom", customType: "compact-transcript-config", data: { enabled: false } }];
	assert.equal((await resolvedConfig({ branch })).enabled, false);
});

test("malformed files and unsupported values fall back to the next level", async () => {
	writeConfigs({ user: { summaryStyle: "quote" }, project: "{ not json" });
	assert.equal((await resolvedConfig()).summaryStyle, "quote", "invalid JSON is ignored");

	writeConfigs({ user: { summaryStyle: "quote" }, project: ["summaryStyle", "off"] });
	assert.equal((await resolvedConfig()).summaryStyle, "quote", "a non-object file is ignored");

	writeConfigs({ user: { summaryStyle: "quote", enabled: "nope", highlightToolActions: 1 }, project: { summaryStyle: "loud" } });
	assert.deepEqual(await resolvedConfig(), { enabled: true, summaryStyle: "quote", highlightToolActions: false });
});

test("legacy mode values still turn the extension on or off", async () => {
	for (const [mode, enabled] of [["disabled", false], ["off", false], ["balanced", true], ["debug", true]] as const) {
		writeConfigs({ user: { mode } });
		assert.equal((await resolvedConfig()).enabled, enabled, `mode: ${mode}`);
	}
});

test("/compact-transcript toggles, sets and reports the state", async () => {
	writeConfigs({});
	const h = harness();
	await h.startSession();
	const last = () => h.notifications.at(-1);
	const toggles = () => h.entries.filter((entry) => entry.type === "compact-transcript-config").map((entry) => entry.data);
	try {
		await h.command("");
		assert.deepEqual(last(), { message: "Compact transcript: off", level: "info" }, "no argument toggles");
		await h.command("");
		assert.deepEqual(last(), { message: "Compact transcript: on", level: "info" });
		await h.command("OFF");
		await h.command("status");
		assert.deepEqual(last(), { message: "Compact transcript: off", level: "info" }, "status reports without changing");
		await h.command("balanced");
		assert.deepEqual(last(), { message: "Compact transcript: on", level: "info" }, "legacy mode names turn it on");
		await h.command("loud");
		assert.equal(last()?.level, "error", "unknown options are rejected");
		assert.match(last()!.message, /Usage: \/compact-transcript \[on\|off\|status\]/);

		// Each change is saved to the session so resume and /reload restore it.
		assert.deepEqual(toggles(), [{ enabled: false }, { enabled: true }, { enabled: false }, { enabled: true }]);
		assert.deepEqual(h.completions("o").map((c: { value: string }) => c.value), ["on", "off"]);
		assert.deepEqual(h.completions("st").map((c: { value: string }) => c.value), ["status"]);
	} finally {
		await h.command("on");
	}
});

test("toggling re-renders rows already on screen", async () => {
	writeConfigs({});
	const h = harness();
	await h.startSession();
	await h.emit("agent_start");
	try {
		const tool = await h.start("a", "read", { path: "a.ts" });
		await h.finish("a");
		assert.equal(row(tool), "◆ read a.ts {ok}");

		await h.command("off");
		assert.ok(lines(tool).length > 1, "turning off switches the existing row to pi's own rendering");

		await h.command("on");
		assert.equal(row(tool), "◆ read a.ts {ok}", "turning on collapses it again");
	} finally {
		await h.command("on");
		await h.emit("session_shutdown");
	}
});
