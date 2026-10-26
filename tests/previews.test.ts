import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { harness, row, stripTags, tagTheme, WIDE } from "./helpers.ts";

// pi reads user config from PI_CODING_AGENT_DIR; point it at a temp folder so
// these tests never inherit the real ~/.pi/agent/compact-transcript.json, which
// may set highlightActionColor to a literal color.
const agentDir = mkdtempSync(join(tmpdir(), "compact-transcript-previews-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

test("each built-in tool gets a recognizable one-line preview", async () => {
	const h = harness();
	await h.startSession();
	await h.emit("agent_start");
	const cases: Array<[name: string, args: object, expected: string]> = [
		["bash", { command: "npm   test\n  --watch" }, "◆ $ npm test --watch {ok}"],
		["read", { path: "src/a.ts" }, "◆ read src/a.ts {ok}"],
		["read", { path: "src/a.ts", offset: 10, limit: 20 }, "◆ read src/a.ts:10-29 {ok}"],
		["read", { path: "src/a.ts", offset: 10 }, "◆ read src/a.ts:10 {ok}"],
		["read", { path: `${homedir()}/notes.md` }, "◆ read ~/notes.md {ok}"],
		["grep", { pattern: "TODO", path: "src", glob: "*.ts" }, '◆ grep "TODO" src (*.ts) {ok}'],
		["grep", { pattern: "TODO" }, '◆ grep "TODO" . {ok}'],
		["find", { pattern: "*.md" }, '◆ find "*.md" . {ok}'],
		["ls", {}, "◆ ls . {ok}"],
		["ls", { path: "src" }, "◆ ls src {ok}"],
	];
	try {
		for (const [index, [name, args, expected]] of cases.entries()) {
			const component = await h.start(`tool-${index}`, name, args);
			// Visible text between calls keeps each one on its own row.
			await h.assistantText();
			await h.finish(`tool-${index}`);
			assert.equal(row(component), expected, `${name} ${JSON.stringify(args)}`);
		}
	} finally {
		await h.emit("session_shutdown");
	}
});

test("unknown tools preview their most meaningful argument instead of raw JSON", async () => {
	const h = harness();
	await h.startSession();
	await h.emit("agent_start");
	const cases: Array<[name: string, args: object, expected: string]> = [
		["web_search", { limit: 5, query: "pi tui" }, "◆ web_search pi tui {ok}"],
		["deploy", { path: `${homedir()}/app`, url: "https://x.dev" }, "◆ deploy ~/app {ok}"],
		["mcp.fetch", { url: "https://x.dev" }, "◆ mcp.fetch https://x.dev {ok}"],
		["custom", { mode: 3, label: "hello   world" }, "◆ custom hello world {ok}"],
		["counter", { n: 1 }, '◆ counter {"n":1} {ok}'],
	];
	try {
		for (const [index, [name, args, expected]] of cases.entries()) {
			const component = await h.start(`tool-${index}`, name, args);
			await h.assistantText();
			await h.finish(`tool-${index}`);
			assert.equal(row(component), expected, name);
		}
	} finally {
		await h.emit("session_shutdown");
	}
});

test("results show as one line, a line count, or running", async () => {
	const h = harness();
	await h.startSession();
	await h.emit("agent_start");
	try {
		const running = await h.start("running", "bash", { command: "sleep 5" });
		assert.equal(row(running), "◆ $ sleep 5 {running}");

		await h.assistantText();
		const single = await h.start("single", "bash", { command: "pwd" });
		await h.finish("single", { content: [{ type: "text", text: "\n/home/me\n" }] });
		assert.equal(row(single), "◆ $ pwd {/home/me}");

		await h.assistantText();
		const multi = await h.start("multi", "bash", { command: "ls" });
		await h.finish("multi", { content: [{ type: "text", text: "a\nb\n\nc\n" }] });
		assert.equal(row(multi), "◆ $ ls {3 lines}");
	} finally {
		await h.emit("session_shutdown");
	}
});

test("a tool that finishes without output no longer says running", async () => {
	const h = harness();
	await h.startSession();
	await h.emit("agent_start");
	try {
		const empty = await h.start("empty", "custom", { name: "noop" });
		await h.finish("empty", { content: [] });
		assert.equal(row(empty), "◆ custom noop");
	} finally {
		await h.emit("session_shutdown");
	}
});

test("durations show from one second up", async (t) => {
	let now = 1_000_000;
	t.mock.method(Date, "now", () => now);
	const h = harness();
	await h.startSession();
	await h.emit("agent_start");
	const cases: Array<[ms: number, expected: string]> = [
		[400, "{ok}"],
		[3_200, "{ok · 3s}"],
		[65_000, "{ok · 1m5s}"],
		[120_000, "{ok · 2m}"],
	];
	try {
		for (const [index, [ms, expected]] of cases.entries()) {
			const component = await h.start(`tool-${index}`, "bash", { command: "make" });
			now += ms;
			await h.assistantText();
			await h.finish(`tool-${index}`);
			assert.equal(row(component), `◆ $ make ${expected}`, `${ms}ms`);
		}
	} finally {
		await h.emit("session_shutdown");
	}
});

test("edit and write rows show git-style line counts instead of output", async () => {
	const h = harness();
	await h.startSession();
	await h.emit("agent_start");
	try {
		const write = await h.start("write", "write", { path: "a.ts", content: "a\nb\nc\n" });
		await h.finish("write");
		assert.equal(row(write), "◆ write a.ts {+3/-0}");

		await h.assistantText();
		const edit = await h.start("edit", "edit", {
			path: "a.ts",
			edits: [
				{ oldText: "a\nb", newText: "x" },
				{ oldText: "c", newText: "y\nz" },
			],
		});
		await h.finish("edit");
		assert.equal(row(edit), "◆ edit a.ts (2 edits) {+3/-3}", "counts come from the edit arguments");

		await h.assistantText();
		const diffed = await h.start("diffed", "edit", { path: "b.ts", edits: [{ oldText: "a", newText: "b" }] });
		await h.finish("diffed", { details: { diff: "--- a/b.ts\n+++ b/b.ts\n-a\n+b\n+c\n context" } });
		assert.equal(row(diffed), "◆ edit b.ts {+2/-1}", "a diff in the result wins over the arguments");

		await h.assistantText();
		const namespaced = await h.start("namespaced", "mcp.edit", { path: "c.ts", edits: [{ oldText: "", newText: "x" }] });
		await h.finish("namespaced");
		assert.equal(row(namespaced), "◆ mcp.edit c.ts {+1/-0}", "namespaced edit tools count lines too");

		await h.assistantText();
		const failed = await h.start("failed", "write", { path: "d.ts", content: "x\n" });
		await h.finish("failed", { isError: true, content: [{ type: "text", text: "EACCES" }] });
		assert.equal(row(failed), "◆ write d.ts {EACCES}", "a failed write shows its error, not counts");
	} finally {
		await h.emit("session_shutdown");
	}
});

test("only the diff signs are colored green and red", async () => {
	const h = harness({ theme: tagTheme });
	await h.startSession();
	await h.emit("agent_start");
	try {
		const write = await h.start("write", "write", { path: "a.ts", content: "a\n" });
		await h.finish("write");
		const rendered = row(write);
		assert.match(rendered, /<toolDiffAdded>\+<\/toolDiffAdded>/, "the plus sign is colored");
		assert.match(rendered, /<toolDiffRemoved>-<\/toolDiffRemoved>/, "the minus sign is colored");
		assert.match(rendered, /\{<\/toolDiffContext><toolDiffAdded>\+<\/toolDiffAdded><toolDiffContext>1/, "counts use the row accent");
	} finally {
		await h.emit("session_shutdown");
	}
});

test("the status marker shows running, success and failure", async () => {
	const h = harness({ theme: tagTheme });
	await h.startSession();
	await h.emit("agent_start");
	try {
		const running = await h.start("running", "bash", { command: "sleep 5" });
		assert.ok(row(running).startsWith("<dim>◆ </dim>"), "running: dim (blinks between ◆ and ◇)");

		await h.assistantText();
		const ok = await h.start("ok", "bash", { command: "true" });
		await h.finish("ok");
		assert.ok(row(ok).startsWith("<success>◆ </success>"), "success: green");
		assert.ok(row(ok).includes("<dim>"), "successful rows are dimmed");

		await h.assistantText();
		const failed = await h.start("failed", "bash", { command: "false" });
		await h.finish("failed", { isError: true, content: [{ type: "text", text: "exit 1" }] });
		assert.ok(row(failed).startsWith("<error>◆ </error>"), "failure: red");
		assert.ok(row(failed).includes("<muted>"), "failed rows keep higher-contrast text");
		assert.equal(stripTags(row(failed)), "◆ $ false {exit 1}");
	} finally {
		await h.emit("session_shutdown");
	}
});

test("highlightToolActions recolors the tool name or shell command", async () => {
	const h = harness({ theme: tagTheme });
	h.setBranch([{ type: "custom", customType: "compact-transcript-config", data: { highlightToolActions: true } }]);
	await h.startSession();
	await h.emit("agent_start");
	try {
		const bash = await h.start("bash", "bash", { command: "npm test -- --watch" });
		await h.finish("bash");
		assert.match(row(bash), /<toolDiffContext>\$ npm<\/toolDiffContext>/);

		await h.assistantText();
		const read = await h.start("read", "read", { path: "a.ts" });
		await h.finish("read");
		assert.match(row(read), /<toolDiffContext>read<\/toolDiffContext>/);
		assert.equal(stripTags(row(read)), "◆ read a.ts {ok}");
	} finally {
		h.setBranch([]);
		await h.emit("session_shutdown");
	}
});

test("highlightActionColor overrides the highlight with a theme token or a literal", async () => {
	const tokenHarness = harness({ theme: tagTheme });
	tokenHarness.setBranch([
		{
			type: "custom",
			customType: "compact-transcript-config",
			data: { highlightToolActions: true, highlightActionColor: "accent" },
		},
	]);
	await tokenHarness.startSession();
	await tokenHarness.emit("agent_start");
	try {
		const read = await tokenHarness.start("read", "read", { path: "a.ts" });
		await tokenHarness.finish("read");
		assert.match(row(read), /<accent>read<\/accent>/);
	} finally {
		tokenHarness.setBranch([]);
		await tokenHarness.emit("session_shutdown");
	}

	const literalHarness = harness({ theme: tagTheme });
	literalHarness.setBranch([
		{
			type: "custom",
			customType: "compact-transcript-config",
			data: { highlightToolActions: true, highlightActionColor: "#7f8aa8" },
		},
	]);
	await literalHarness.startSession();
	await literalHarness.emit("agent_start");
	try {
		const read = await literalHarness.start("read", "read", { path: "a.ts" });
		await literalHarness.finish("read");
		// A literal is emitted as an ANSI color, since the theme has no token for it.
		// row() strips escape sequences, so assert against the raw render.
		assert.match(read.render(WIDE).join("\n"), /\x1b\[38;[\d;]+mread/);
	} finally {
		literalHarness.setBranch([]);
		await literalHarness.emit("session_shutdown");
	}
});

test("the highlighted action and the stats brackets share one tone", async () => {
	const h = harness({ theme: tagTheme });
	h.setBranch([
		{
			type: "custom",
			customType: "compact-transcript-config",
			data: { highlightToolActions: true, highlightActionColor: "accent" },
		},
	]);
	await h.startSession();
	await h.emit("agent_start");
	try {
		const write = await h.start("write", "write", { path: "a.ts", content: "a\n" });
		await h.finish("write");
		const rendered = row(write);
		assert.match(rendered, /<accent>write<\/accent>/, "the action uses the accent");
		assert.match(rendered, /<accent>\{<\/accent>/, "the opening bracket uses the accent");
		assert.match(rendered, /<accent>\/<\/accent>/, "the separating slash uses the accent");
		assert.match(rendered, /<accent>\}<\/accent>/, "the closing bracket uses the accent");
		assert.match(rendered, /<accent>1<\/accent>/, "the counts use the accent");
		assert.ok(!rendered.includes("toolDiffContext"), "no second tone leaks into the row");
	} finally {
		h.setBranch([]);
		await h.emit("session_shutdown");
	}
});
