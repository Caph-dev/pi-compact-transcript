import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { harness, lines, row } from "./helpers.ts";

const failure = { isError: true, content: [{ type: "text", text: "ENOENT" }] };

test("repeated calls of the same tool coalesce into one counted row", async () => {
	const h = harness();
	await h.startSession();
	await h.emit("agent_start");
	try {
		const a = await h.start("a", "read", { path: "a.ts" });
		await h.finish("a");
		const b = await h.start("b", "read", { path: "b.ts" });
		await h.finish("b");
		const c = await h.start("c", "read", { path: "c.ts" });
		await h.finish("c");
		assert.deepEqual(lines(a), [], "earlier calls are folded into the burst row");
		assert.deepEqual(lines(b), []);
		assert.equal(row(c), "◆ 3× read c.ts {ok}");
	} finally {
		await h.emit("session_shutdown");
	}
});

test("a burst row shows the combined duration of its calls", async (t) => {
	let now = 1_000_000;
	t.mock.method(Date, "now", () => now);
	const h = harness();
	await h.startSession();
	await h.emit("agent_start");
	try {
		await h.start("a", "bash", { command: "make a" });
		now += 2_000;
		await h.finish("a");
		const b = await h.start("b", "bash", { command: "make b" });
		now += 3_000;
		await h.finish("b");
		assert.equal(row(b), "◆ 2× $ make b {ok · 5s}");
	} finally {
		await h.emit("session_shutdown");
	}
});

test("a different tool or visible assistant text starts a new row", async () => {
	const h = harness();
	await h.startSession();
	await h.emit("agent_start");
	try {
		const a = await h.start("a", "read", { path: "a.ts" });
		await h.finish("a");
		const grep = await h.start("grep", "grep", { pattern: "x" });
		await h.finish("grep");
		const b = await h.start("b", "read", { path: "b.ts" });
		await h.finish("b");
		assert.equal(row(a), "◆ read a.ts {ok}", "a different tool leaves the previous row visible");
		assert.equal(row(grep), '◆ grep "x" . {ok}');
		assert.equal(row(b), "◆ read b.ts {ok}");

		await h.assistantText("Now the tests.");
		const c = await h.start("c", "read", { path: "c.ts" });
		await h.finish("c");
		assert.equal(row(b), "◆ read b.ts {ok}", "assistant text ends the burst");
		assert.equal(row(c), "◆ read c.ts {ok}");
	} finally {
		await h.emit("session_shutdown");
	}
});

test("whitespace-only assistant text does not split a burst", async () => {
	const h = harness();
	await h.startSession();
	await h.emit("agent_start");
	try {
		await h.start("a", "read", { path: "a.ts" });
		await h.finish("a");
		await h.assistantText("  \n ");
		const b = await h.start("b", "read", { path: "b.ts" });
		await h.finish("b");
		assert.equal(row(b), "◆ 2× read b.ts {ok}");
	} finally {
		await h.emit("session_shutdown");
	}
});

test("a failed call gets its own row and the next call starts a fresh count", async () => {
	const h = harness();
	await h.startSession();
	await h.emit("agent_start");
	try {
		const a = await h.start("a", "read", { path: "a.ts" });
		await h.finish("a", failure);
		const b = await h.start("b", "read", { path: "b.ts" });
		await h.finish("b");
		const c = await h.start("c", "read", { path: "c.ts" });
		await h.finish("c");
		assert.equal(row(a), "◆ read a.ts {ENOENT}", "the failure stays visible");
		assert.deepEqual(lines(b), []);
		assert.equal(row(c), "◆ 2× read c.ts {ok}", "the count restarts after the failure");
	} finally {
		await h.emit("session_shutdown");
	}
});

test("calls before a failure in the same burst stay visible", async () => {
	const h = harness();
	await h.startSession();
	await h.emit("agent_start");
	try {
		const a = await h.start("a", "read", { path: "a.ts" });
		await h.finish("a");
		const b = await h.start("b", "read", { path: "b.ts" });
		await h.finish("b");
		const c = await h.start("c", "read", { path: "c.ts" });
		await h.finish("c", failure);
		assert.deepEqual(lines(a), []);
		assert.equal(row(b), "◆ 2× read b.ts {ok}", "the calls before the failure keep their burst row");
		assert.equal(row(c), "◆ read c.ts {ENOENT}");
	} finally {
		await h.emit("session_shutdown");
	}
});

test("bursts are not grouped while the extension is off", async () => {
	const h = harness();
	await h.startSession();
	try {
		await h.command("off");
		await h.emit("agent_start");
		const a = await h.start("a", "read", { path: "a.ts" });
		await h.finish("a");
		const b = await h.start("b", "read", { path: "b.ts" });
		await h.finish("b");
		await h.command("on");
		assert.equal(row(a), "◆ read a.ts {ok}", "rows from while it was off stay separate");
		assert.equal(row(b), "◆ read b.ts {ok}");
	} finally {
		await h.emit("session_shutdown");
	}
});

test("rows rebuilt from history coalesce the same way as live rows", async () => {
	const h = harness();
	await h.startSession("resume");
	try {
		const a = h.restore("a", "read", { path: "a.ts" });
		const b = h.restore("b", "read", { path: "b.ts" });
		const c = h.restore("c", "read", { path: "c.ts" });
		const grep = h.restore("grep", "grep", { pattern: "x" });
		assert.deepEqual(lines(a), []);
		assert.deepEqual(lines(b), []);
		assert.equal(row(c), "◆ 3× read c.ts {ok}");
		assert.equal(row(grep), '◆ grep "x" . {ok}');
	} finally {
		await h.emit("session_shutdown");
	}
});

test("assistant text in history splits bursts", async () => {
	const h = harness();
	await h.startSession("resume");
	try {
		const a = h.restore("a", "read", { path: "a.ts" });
		// pi rebuilds the assistant message between the two tool calls.
		new AssistantMessageComponent(
			{ role: "assistant", content: [{ type: "text", text: "Now the next file." }] } as any,
			true,
		);
		const b = h.restore("b", "read", { path: "b.ts" });
		assert.equal(row(a), "◆ read a.ts {ok}");
		assert.equal(row(b), "◆ read b.ts {ok}");
	} finally {
		await h.emit("session_shutdown");
	}
});

test("starting a new session drops burst counts from the previous one", async () => {
	const h = harness();
	await h.startSession();
	await h.emit("agent_start");
	try {
		await h.start("a", "read", { path: "a.ts" });
		await h.finish("a");
		await h.start("b", "read", { path: "b.ts" });
		await h.finish("b");

		// /reload or resume rebuilds the transcript from history.
		await h.startSession("reload");
		const restored = h.restore("c", "read", { path: "c.ts" });
		assert.equal(row(restored), "◆ read c.ts {ok}");
	} finally {
		await h.emit("session_shutdown");
	}
});

test("a failure in history ends the burst like it does live", async () => {
	const h = harness();
	await h.startSession("resume");
	try {
		const a = h.restore("a", "read", { path: "a.ts" });
		const b = h.restore("b", "read", { path: "b.ts" }, failure);
		const c = h.restore("c", "read", { path: "c.ts" });
		assert.equal(row(a), "◆ read a.ts {ok}", "the call before the failure keeps its row");
		assert.equal(row(b), "◆ read b.ts {ENOENT}");
		assert.equal(row(c), "◆ read c.ts {ok}", "the count restarts after the failure");
	} finally {
		await h.emit("session_shutdown");
	}
});
