import { vi } from "vitest";
import indexHtml from "../../index.html?raw";
import { FakeWebSocket } from "./fake-websocket.js";

/**
 * The tests run against the real `index.html` markup rather than a hand-copied
 * fixture, so renaming or dropping a control the app looks up by id fails here
 * instead of only in a browser.
 */
function appMarkup(): string {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(indexHtml);
  if (!body) throw new Error("index.html has no <body>");
  return body[1].replace(/<script[\s\S]*?<\/script>/gi, "");
}

export interface MountOptions {
  /** Value of `window.ENV.WS_URL`. Omit to leave `window.ENV` unset. */
  wsUrl?: string;
}

/**
 * `app.ts` boots as a side effect of being imported, so each mount rebuilds the
 * DOM and re-imports the module with a clean registry.
 */
export async function mountApp(options: MountOptions = {}): Promise<void> {
  document.body.innerHTML = appMarkup();

  if (options.wsUrl === undefined) {
    delete window.ENV;
  } else {
    window.ENV = { WS_URL: options.wsUrl };
  }

  vi.resetModules();
  await import("../../src/app.js");

  // Let the boot sequence reach its first await: the socket (or the local
  // transport's open tick) exists from here on.
  await vi.advanceTimersByTimeAsync(1);
}

export function teardownApp(): void {
  vi.clearAllTimers();
  document.body.innerHTML = "";
  delete window.ENV;
  FakeWebSocket.reset();
}

/** Advances fake time and flushes the promise chain the transports run on. */
export async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function required<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
}

export const composer = (): HTMLTextAreaElement =>
  required<HTMLTextAreaElement>("#message-input");

export const sendButton = (): HTMLButtonElement =>
  required<HTMLButtonElement>("#send-btn");

export const retryButton = (): HTMLButtonElement =>
  required<HTMLButtonElement>("#retry-btn");

export const statusText = (): string =>
  required("#ws-status").textContent?.trim() ?? "";

export const transcript = (): string =>
  required("#messages").textContent ?? "";

/** The bubble's own text, without the "You"/"Bot" badge or the queued note. */
function bubbleText(bubble: Element): string {
  const content = bubble.querySelector(
    ":scope > div:not(.role-badge):not(.message-note)"
  );
  return content?.textContent ?? "";
}

function bubbles(selector: string): string[] {
  return Array.from(document.querySelectorAll(selector)).map(bubbleText);
}

/** User turns committed to the transcript (the queued placeholder excluded). */
export const userMessages = (): string[] =>
  bubbles(".message-row.user .message-bubble:not(.pending)");

/** The dimmed bubble for a message waiting on the connection, if any. */
export function queuedMessage(): string | null {
  const bubble = document.querySelector(".message-bubble.pending");
  return bubble ? bubbleText(bubble) : null;
}

export const queuedNote = (): string =>
  document.querySelector(".message-bubble.pending .message-note")
    ?.textContent ?? "";

export const assistantMessages = (): string[] =>
  bubbles(".message-row.assistant .message-bubble.assistant");

export const systemMessages = (): string[] =>
  bubbles(".message-bubble.system");

/** Every system line as one string, for "did the app say X" assertions. */
export const systemText = (): string => systemMessages().join(" | ");

export const emptyState = (): Element | null =>
  document.querySelector(".empty-state");

/** Types `text` and presses Enter, exactly as a user would. */
export function pressEnter(text: string): void {
  const input = composer();
  input.value = text;
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
  );
}

/**
 * Types `text` and clicks Send -- the only path a pointer or touch user has,
 * since they have no Enter key. A disabled button dispatches no click at all,
 * so this silently does nothing whenever the control is dead.
 */
export function clickSend(text: string): void {
  composer().value = text;
  sendButton().click();
}
