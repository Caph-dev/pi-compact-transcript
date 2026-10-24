import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import compactTranscript from "../extensions/compact-transcript.ts";

test("compact tool and thought rows use render width and recover on resize", async () => {
	const handlers = new Map<string, Function>();
	const theme = {
		fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	} as Theme;
	const ctx = { ui: { theme, setStatus() {}, setWorkingMessage() {} } } as unknown as ExtensionContext;
	compactTranscript({
		on: (event: string, handler: Function) => handlers.set(event, handler),
		registerCommand() {},
		registerEntryRenderer() {},
	} as unknown as ExtensionAPI);
	const emit = (name: string, event = {}) => handlers.get(name)!(event, ctx);
	emit("agent_start");
	try {
		const command = `echo ${"界🙂é ".repeat(35)}END_OF_COMMAND`;
		const args = { command };
		emit("tool_execution_start", { toolCallId: "width-test", toolName: "bash", args });
		const component = new ToolExecutionComponent("bash", "width-test", args, {}, undefined,
			{ requestRender() {} } as unknown as TUI, process.cwd());
		const expected = `◆ $ ${command} {running}`;
		const checkTool = (width: number) => {
			const lines = component.render(width);
			assert.equal(lines.length, 1);
			assert.equal(stripTerminalSequences(lines[0]), stripTerminalSequences(truncateToWidth(expected, width, "…")));
			assert.ok(visibleWidth(lines[0]) <= width);
			assert.ok(lines[0].includes("\x1b["), "theme styling is preserved");
		};
		checkTool(220); // Beyond the old 104-cell preview cap.
		checkTool(24);
		checkTool(600); // No invalidate/update between widths: recover the full line.

		const heading = `Considering ${"界🙂é ".repeat(35)}END_OF_THOUGHT`;
		emit("message_update", {
			assistantMessageEvent: { type: "thinking_delta" },
			message: { content: [{ type: "thinking", thinking: heading }] },
		});
		for (const width of [220, 24, 600]) {
			const lines = component.render(width);
			assert.equal(lines.length, 2, "thought ticker stays a single row");
			assert.equal(stripTerminalSequences(lines[1]), stripTerminalSequences(truncateToWidth(`  ↳ ${heading}`, width, "…")));
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
	} finally {
		await emit("session_shutdown");
	}
});

test("compact tool and thought rows reuse their truncated line until the width changes", async () => {
	const handlers = new Map<string, Function>();
	const theme = {
		fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	} as Theme;
	const ctx = { ui: { theme, setStatus() {}, setWorkingMessage() {} } } as unknown as ExtensionContext;
	compactTranscript({
		on: (event: string, handler: Function) => handlers.set(event, handler),
		registerCommand() {},
		registerEntryRenderer() {},
	} as unknown as ExtensionAPI);
	const emit = (name: string, event = {}) => handlers.get(name)!(event, ctx);
	emit("agent_start");
	try {
		const args = { command: `echo ${"界🙂é ".repeat(35)}END_OF_COMMAND` };
		emit("tool_execution_start", { toolCallId: "cache-test", toolName: "bash", args });
		const component = new ToolExecutionComponent("bash", "cache-test", args, {}, undefined,
			{ requestRender() {} } as unknown as TUI, process.cwd());
		emit("message_update", {
			assistantMessageEvent: { type: "thinking_delta" },
			message: { content: [{ type: "thinking", thinking: "Considering the cache" }] },
		});
		const rows = (Reflect.get(component, "selfRenderContainer") as { children: { render(width: number): string[] }[] })
			.children;
		assert.equal(rows.length, 2, "tool row and thought row");
		for (const row of rows) {
			const first = row.render(80);
			assert.equal(row.render(80), first, "same width reuses the truncated line");
			const narrow = row.render(24);
			assert.notEqual(narrow, first, "a new width truncates again");
			assert.ok(visibleWidth(narrow[0]) <= 24);
		}
	} finally {
		await emit("session_shutdown");
	}
});

test("commentary rail reuses its railed lines until the width changes", async () => {
	initTheme("dark", false);
	const handlers = new Map<string, Function>();
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
	const ctx = { ui: { theme, setStatus() {}, setWorkingMessage() {} } } as unknown as ExtensionContext;
	compactTranscript({
		on: (event: string, handler: Function) => handlers.set(event, handler),
		registerCommand() {},
		registerEntryRenderer() {},
	} as unknown as ExtensionAPI);
	const emit = (name: string, event = {}) => handlers.get(name)!(event, ctx);
	emit("agent_start");
	try {
		const component = new AssistantMessageComponent({
			role: "assistant",
			content: [
				{ type: "text", text: "Checking the files before running the tests." },
				{ type: "toolCall", id: "rail-test", name: "bash", arguments: { command: "ls" } },
			],
		} as unknown as ConstructorParameters<typeof AssistantMessageComponent>[0]);
		const children = (Reflect.get(component, "contentContainer") as { children: object[] }).children;
		const rail = children.find((child) => child.constructor.name === "CommentaryRail") as
			| { render(width: number): string[] }
			| undefined;
		assert.ok(rail, "commentary is framed by the rail");
		const first = rail.render(80);
		assert.ok(first.some((line) => stripTerminalSequences(line).startsWith("│  Checking the files")));
		assert.equal(rail.render(80), first, "same width reuses the railed lines");
		const narrow = rail.render(30);
		assert.notEqual(narrow, first, "a new width rebuilds the railed lines");
		assert.ok(narrow.every((line) => visibleWidth(line) <= 30));
	} finally {
		await emit("session_shutdown");
	}
});

test("collapsing tool output clears image sources together with image components", async () => {
	initTheme("dark", false);
	const handlers = new Map<string, Function>();
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as Theme;
	const ctx = { ui: { theme, setStatus() {}, setWorkingMessage() {} } } as unknown as ExtensionContext;
	compactTranscript({
		on: (event: string, handler: Function) => handlers.set(event, handler),
		registerCommand() {},
		registerEntryRenderer() {},
	} as unknown as ExtensionAPI);
	const emit = (name: string, event = {}) => handlers.get(name)!(event, ctx);
	emit("agent_start");
	try {
		const component = new ToolExecutionComponent("read", "image-test", { path: "image.png" }, {}, undefined,
			{ requestRender() {} } as unknown as TUI, process.cwd());
		component.setExpanded(true);
		// Seed the private image cache as if expanded output had rendered an image.
		// A stale source lets pi reuse an undefined component on the next expansion.
		Reflect.set(component, "imageComponents", [{ render: () => ["image"], invalidate() {} }]);
		Reflect.set(component, "imageSources", [{ data: "image", mimeType: "image/png", widthCells: 80 }]);
		component.setExpanded(false);
		assert.deepEqual(Reflect.get(component, "imageComponents"), []);
		assert.deepEqual(Reflect.get(component, "imageSources"), []);
		assert.doesNotThrow(() => {
			component.setExpanded(true);
			component.render(80);
		});
	} finally {
		await emit("session_shutdown");
	}
});

test("summaryStyle off hides activity summaries", async () => {
	const handlers = new Map<string, Function>();
	const renderers = new Map<string, Function>();
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
	let configEntries: unknown[] = [];
	const ctx = {
		ui: { theme, setStatus() {}, setWorkingMessage() {} },
		cwd: process.cwd(),
		isProjectTrusted: () => false,
		sessionManager: { getBranch: () => configEntries },
	} as unknown as ExtensionContext;
	compactTranscript({
		on: (event: string, handler: Function) => handlers.set(event, handler),
		registerCommand() {},
		registerEntryRenderer: (type: string, renderer: Function) => renderers.set(type, renderer),
	} as unknown as ExtensionAPI);
	const startWith = async (summaryStyle: string) => {
		configEntries = [{ type: "custom", customType: "compact-transcript-config", data: { summaryStyle } }];
		await handlers.get("session_start")!({ reason: "reload" }, ctx);
	};
	const render = renderers.get("compact-transcript-summary")!;
	const entry = { data: { reads: 2, edits: 1, commands: 0, others: 0, failed: 0, durationMs: 4000 } };
	try {
		await startWith("off");
		assert.equal(render(entry, {}, theme), undefined);
		await startWith("plain");
		assert.ok(render(entry, {}, theme), "summaries render again when switched back on");
	} finally {
		await handlers.get("session_shutdown")!({}, ctx);
	}
});

function mouseHarness() {
	initTheme("dark", false);
	const handlers = new Map<string, Function>();
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
	let configEntries: unknown[] = [];
	const ctx = {
		ui: { theme, setStatus() {}, setWorkingMessage() {} },
		cwd: process.cwd(),
		isProjectTrusted: () => false,
		sessionManager: { getBranch: () => configEntries },
	} as unknown as ExtensionContext;
	const pi = {
		on: (event: string, handler: Function) => handlers.set(event, handler),
		registerCommand() {},
		registerEntryRenderer() {},
	} as unknown as ExtensionAPI;
	compactTranscript(pi);
	const emit = (name: string, event = {}) => handlers.get(name)!(event, ctx);
	const tui = { requestRender() {} } as unknown as TUI;
	return {
		pi,
		emit,
		setEnabled: async (enabled: boolean) => {
			configEntries = [{ type: "custom", customType: "compact-transcript-config", data: { enabled } }];
			await emit("session_start", { reason: "reload" });
		},
		tool: (id: string, toolName: string, args: object, definition?: object) => {
			emit("tool_execution_start", { toolCallId: id, toolName, args });
			return new ToolExecutionComponent(toolName, id, args, {}, definition as any, tui, process.cwd());
		},
		finish: (component: ToolExecutionComponent) =>
			component.updateResult({ content: [{ type: "text", text: "done" }], isError: false }),
		click: (component: ToolExecutionComponent, y: number, { button = "left", height = 1 } = {}) =>
			component.handleMouse({
				type: "click", button, x: 2, y, screenX: 2, screenY: y, width: 80, height,
				shift: false, alt: false, ctrl: false,
			} as Parameters<ToolExecutionComponent["handleMouse"]>[0]),
		expanded: (component: ToolExecutionComponent) => Reflect.get(component, "expanded") as boolean,
	};
}

test("clicking a compact tool row toggles only that tool", async () => {
	const { emit, tool, finish, click, expanded } = mouseHarness();
	emit("agent_start");
	try {
		// Different tools, so the rows are not merged into one burst row.
		const clicked = tool("click-a", "bash", { command: "ls" });
		const other = tool("click-b", "read", { path: "file.txt" });

		assert.equal(click(clicked, 0), undefined, "a running tool without a result does not expand");
		finish(clicked);
		finish(other);
		assert.equal(click(clicked, 0, { button: "right" }), undefined, "right clicks are ignored");
		assert.equal(expanded(clicked), false);

		// The thought row only shows while pi hides thinking; earlier tests may have turned that off.
		Reflect.set(Reflect.get(globalThis, Symbol.for("pi-compact-transcript.state")), "thinkingHidden", true);
		emit("message_update", {
			assistantMessageEvent: { type: "thinking_delta" },
			message: { content: [{ type: "thinking", thinking: "Considering the files" }] },
		});
		assert.equal(other.render(80).length, 2, "thought row is shown under the latest tool");
		assert.equal(click(other, 1, { height: 2 }), undefined, "the thought row does not toggle");
		assert.equal(expanded(other), false);

		assert.deepEqual(click(clicked, 0), { handled: true });
		assert.equal(expanded(clicked), true);
		assert.equal(expanded(other), false, "other tools stay collapsed");
		assert.ok(clicked.render(80).length > 1, "expanded tool renders natively");
	} finally {
		await emit("session_shutdown");
	}
});

test("hidden burst rows ignore clicks and the burst row expands", async () => {
	const { emit, tool, finish, click, expanded } = mouseHarness();
	emit("agent_start");
	try {
		const first = tool("burst-a", "bash", { command: "ls" });
		const second = tool("burst-b", "bash", { command: "pwd" });
		finish(first);
		finish(second);
		assert.deepEqual(first.render(80), [], "first call is folded into the burst row");
		assert.equal(click(first, 0), undefined);
		assert.equal(expanded(first), false);
		assert.deepEqual(click(second, 0), { handled: true });
		assert.equal(expanded(second), true);
	} finally {
		await emit("session_shutdown");
	}
});

const RENDER_SHELLS: Array<[string, object | undefined]> = [
	["no renderer", undefined],
	["default shell", { renderCall: () => new Text("custom call", 0, 0), renderResult: () => new Text("result", 0, 0) }],
	["self shell", {
		renderShell: "self",
		renderCall: () => new Text("custom call", 0, 0),
		renderResult: () => new Text("result", 0, 0),
	}],
];

// Clicks a row of pi's native rendering that belongs to the tool call.
function clickNativeRow(
	harness: ReturnType<typeof mouseHarness>,
	component: ToolExecutionComponent,
	label: string,
) {
	const lines = component.render(80);
	const y = lines.findIndex((line) => stripTerminalSequences(line).includes(label));
	assert.ok(y > 0, `native row containing ${label} is rendered`);
	return harness.click(component, y, { height: lines.length });
}

test("expanded tools collapse through pi's own click handling", async () => {
	const harness = mouseHarness();
	const { emit, tool, finish, click, expanded } = harness;
	emit("agent_start");
	try {
		for (const [index, [shell, definition]] of RENDER_SHELLS.entries()) {
			// Distinct tool names keep each row out of the previous one's burst.
			const name = `shell-tool-${index}`;
			const component = tool(`shell-${index}`, name, { path: "file.txt" }, definition);
			finish(component);
			assert.deepEqual(click(component, 0), { handled: true }, `${shell}: compact row expands`);
			assert.equal(expanded(component), true);
			const label = definition ? "custom call" : name;
			assert.equal(clickNativeRow(harness, component, label)?.handled, true, `${shell}: native click`);
			assert.equal(expanded(component), false, `${shell}: native click collapses`);
			assert.equal(component.render(80).length, 1, `${shell}: back to one compact row`);
		}
	} finally {
		await emit("session_shutdown");
	}
});

test("with the extension off, clicks use pi's own handling", async () => {
	const harness = mouseHarness();
	const { emit, setEnabled, tool, finish, expanded } = harness;
	await setEnabled(false);
	emit("agent_start");
	try {
		for (const [index, [shell, definition]] of RENDER_SHELLS.entries()) {
			const name = `off-tool-${index}`;
			const component = tool(`off-${index}`, name, { path: "file.txt" }, definition);
			finish(component);
			const label = definition ? "custom call" : name;
			assert.equal(clickNativeRow(harness, component, label)?.handled, true, `${shell}: native click`);
			assert.equal(expanded(component), true, `${shell}: native click expands`);
		}
	} finally {
		await setEnabled(true);
		await emit("session_shutdown");
	}
});

test("global expand still switches compact rows to native output", async () => {
	const { emit, tool, finish } = mouseHarness();
	emit("agent_start");
	try {
		const tools = [tool("global-a", "bash", { command: "ls" }), tool("global-b", "read", { path: "file.txt" })];
		for (const component of tools) finish(component);
		// Ctrl+O expands every tool through setExpanded.
		for (const component of tools) component.setExpanded(true);
		for (const component of tools) assert.ok(component.render(80).length > 1);
		for (const component of tools) component.setExpanded(false);
		for (const component of tools) assert.equal(component.render(80).length, 1);
	} finally {
		await emit("session_shutdown");
	}
});

test("reloading the extension does not stack the mouse patch", async () => {
	const proto = ToolExecutionComponent.prototype as any;
	const patchRecord = () => proto[Symbol.for("pi-compact-transcript.tool-patch")];
	const first = mouseHarness();
	const native = patchRecord().originalHandleMouse;
	assert.equal(typeof native, "function");
	assert.notEqual(native.name, "patchedHandleMouse", "the stored handler is pi's own");
	const { emit, tool, finish, click, expanded } = mouseHarness();
	assert.equal(patchRecord().originalHandleMouse, native, "reload keeps pi's original handler");
	emit("agent_start");
	try {
		const component = tool("reload-a", "bash", { command: "ls" });
		finish(component);
		assert.deepEqual(click(component, 0), { handled: true });
		assert.equal(expanded(component), true, "one click toggles exactly once");
	} finally {
		await emit("session_shutdown");
		await first.emit("session_shutdown");
	}
});
