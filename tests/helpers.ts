import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import compactTranscript from "../extensions/compact-transcript.ts";

// Wide enough that rows are never truncated in assertions.
export const WIDE = 1000;

/** Leaves text unstyled, so rows can be compared as plain strings. */
export const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

/** Wraps styled text as <color>text</color>, so tests can check which theme color was used. */
export const tagTheme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => `<b>${text}</b>`,
} as Theme;

export function stripTags(text: string): string {
	return text.replace(/<\/?[a-zA-Z]+>/g, "");
}

type ToolResult = {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError: boolean;
};

/**
 * Loads the extension against a fake pi and drives it the way pi does:
 * extension events plus the ToolExecutionComponent calls pi makes for each tool.
 */
export function harness({ theme = plainTheme, trusted = false, cwd = process.cwd() } = {}) {
	initTheme("dark", false);
	const handlers = new Map<string, Function>();
	const commands = new Map<string, any>();
	const renderers = new Map<string, Function>();
	const entries: Array<{ type: string; data: any }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	let branch: unknown[] = [];
	const tui = { requestRender() {} } as unknown as TUI;
	const components = new Map<string, ToolExecutionComponent>();

	const ctx = {
		ui: {
			theme,
			setStatus() {},
			setWorkingMessage() {},
			notify: (message: string, level: string) => notifications.push({ message, level }),
			confirm: async () => false,
		},
		cwd,
		mode: "tui",
		isProjectTrusted: () => trusted,
		sessionManager: { getBranch: () => branch },
	} as unknown as ExtensionContext;

	const pi = {
		on: (event: string, handler: Function) => handlers.set(event, handler),
		registerCommand: (name: string, command: unknown) => commands.set(name, command),
		registerEntryRenderer: (type: string, renderer: Function) => renderers.set(type, renderer),
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
	} as unknown as ExtensionAPI;
	compactTranscript(pi);

	const emit = async (name: string, event: object = {}) => handlers.get(name)?.(event, ctx);

	/** Creates the transcript row pi shows for a tool call. */
	const component = (id: string, name: string, args: object) => {
		const created = new ToolExecutionComponent(name, id, args, {}, undefined, tui, process.cwd());
		components.set(id, created);
		return created;
	};

	return {
		pi,
		ctx,
		emit,
		entries,
		notifications,
		components,
		/** Session entries pi replays on session_start (e.g. /compact-transcript toggles). */
		setBranch: (next: unknown[]) => {
			branch = next;
		},
		startSession: (reason = "reload") => emit("session_start", { reason }),
		command: (args: string) => commands.get("compact-transcript").handler(args, ctx),
		completions: (prefix: string) => commands.get("compact-transcript").getArgumentCompletions(prefix),
		renderSummary: (data: unknown) => renderers.get("compact-transcript-summary")!({ data }, {}, theme),

		/** Starts a tool live: the tool_execution_start event plus its transcript row. */
		start: async (id: string, name: string, args: object = {}) => {
			await emit("tool_execution_start", { toolCallId: id, toolName: name, args });
			return component(id, name, args);
		},
		/** Finishes a live tool: the tool_execution_end event plus the row's result. */
		finish: async (id: string, result: Partial<ToolResult> = {}) => {
			const full: ToolResult = { content: [{ type: "text", text: "ok" }], isError: false, ...result };
			await emit("tool_execution_end", { toolCallId: id, result: full, isError: full.isError });
			components.get(id)!.updateResult(full, false);
		},
		/** A tool call rebuilt from history: pi creates the row and sets its result, with no live events. */
		restore: (id: string, name: string, args: object = {}, result: Partial<ToolResult> = {}) => {
			const created = component(id, name, args);
			created.updateResult({ content: [{ type: "text", text: "ok" }], isError: false, ...result }, false);
			return created;
		},
		/** Visible assistant text, which ends the current burst. */
		assistantText: (text = "Next step.") =>
			emit("message_update", {
				assistantMessageEvent: { type: "text_delta", delta: text },
				message: { content: [{ type: "text", text }] },
			}),
	};
}

/** The rendered lines of a row, with terminal styling removed. */
export function lines(component: { render(width: number): string[] }, width = WIDE): string[] {
	return component.render(width).map((line) => stripTerminalSequences(line));
}

/** The single compact line of a row ("" when the row is hidden). */
export function row(component: { render(width: number): string[] }, width = WIDE): string {
	const rendered = lines(component, width);
	if (rendered.length > 1) throw new Error(`expected one compact row, got ${rendered.length} lines`);
	return rendered[0] ?? "";
}
