import assert from "node:assert/strict";
import test from "node:test";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { harness, lines } from "./helpers.ts";

const SUMMARY = "compact-transcript-summary";

test("each multi-tool run appends a summary of what it did", async (t) => {
	let now = 1_000_000;
	t.mock.method(Date, "now", () => now);
	const h = harness();
	await h.startSession();
	await h.emit("agent_start");
	try {
		const calls: Array<[name: string, args: object, failed?: boolean]> = [
			["read", { path: "a.ts" }],
			["read", { path: "a.ts" }],
			["read", { path: "b.ts" }],
			["edit", { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] }],
			["write", { path: "c.ts", content: "c" }],
			["bash", { command: "npm test" }],
			["bash", { command: "npm run lint" }, true],
			["web_search", { query: "pi" }],
		];
		for (const [index, [name, args, failed]] of calls.entries()) {
			await h.start(`tool-${index}`, name, args);
			await h.finish(`tool-${index}`, failed ? { isError: true } : {});
		}
		now += 42_000;
		await h.emit("agent_end");

		assert.deepEqual(h.entries.filter((entry) => entry.type === SUMMARY), [{
			type: SUMMARY,
			// Files are counted once, however often they were touched.
			data: { reads: 2, edits: 2, commands: 2, others: 1, failed: 1, durationMs: 42_000 },
		}]);
	} finally {
		await h.emit("session_shutdown");
	}
});

test("single-tool runs and runs while off get no summary", async () => {
	const h = harness();
	await h.startSession();
	try {
		await h.emit("agent_start");
		await h.start("one", "read", { path: "a.ts" });
		await h.finish("one");
		await h.emit("agent_end");
		assert.equal(h.entries.filter((entry) => entry.type === SUMMARY).length, 0, "one tool repeats the row above");

		await h.command("off");
		await h.emit("agent_start");
		await h.start("a", "read", { path: "a.ts" });
		await h.finish("a");
		await h.start("b", "bash", { command: "ls" });
		await h.finish("b");
		await h.emit("agent_end");
		assert.equal(h.entries.filter((entry) => entry.type === SUMMARY).length, 0, "no summary while off");
	} finally {
		await h.command("on");
		await h.emit("session_shutdown");
	}
});

test("summary text lists counts with plurals and duration", async () => {
	const h = harness();
	await h.startSession();
	const text = (data: object) => lines(h.renderSummary(data)).join("\n").trim();
	assert.equal(
		text({ reads: 6, edits: 2, commands: 3, others: 0, failed: 1, durationMs: 42_000 }),
		"Read 6 files, edited 2 files, ran 3 commands, 1 failed · 42s",
	);
	assert.equal(
		text({ reads: 1, edits: 1, commands: 1, others: 1, failed: 0, durationMs: 400 }),
		"Read 1 file, edited 1 file, ran 1 command, 1 other tool",
		"singular forms, and no duration under a second",
	);
	assert.equal(text({ commands: 2, others: 3, durationMs: 90_000 }), "Ran 2 commands, 3 other tools · 1m30s");
	assert.equal(h.renderSummary({}), undefined, "nothing to say renders nothing");
	assert.equal(
		text({ reads: -1, edits: Number.NaN, commands: "3", others: 2 }),
		"2 other tools",
		"invalid stored values are ignored",
	);
});

test("summaryStyle picks muted text, a quote, or nothing", async () => {
	const h = harness();
	const data = { reads: 2, durationMs: 0 };
	const withStyle = async (summaryStyle: string) => {
		h.setBranch([{ type: "custom", customType: "compact-transcript-config", data: { summaryStyle } }]);
		await h.startSession();
		return h.renderSummary(data);
	};
	try {
		assert.ok((await withStyle("plain")) instanceof Text);
		const quoted = await withStyle("quote");
		assert.ok(quoted instanceof Markdown);
		assert.match(lines(quoted).join("\n"), /Read 2 files/);
		assert.equal(await withStyle("off"), undefined);
		assert.ok((await withStyle("fancy")) instanceof Text, "unknown styles fall back to plain");
	} finally {
		h.setBranch([]);
	}
});
