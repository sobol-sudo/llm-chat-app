import type {
  WSMessage,
  Message,
  ActiveStream,
  ChatTransport,
  TransportHandlers,
  TransportKind,
  TransportState,
} from "./types.js";
import { LocalTransport } from "./local-transport.js";
import { OPEN_TIMEOUT_MS, WebSocketTransport } from "./ws-transport.js";

const DEV_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]", ""];

const configuredWsUrl = (window.ENV?.WS_URL ?? "").trim();

/**
 * A WebSocket URL is used whenever one is configured. Without configuration we
 * only guess at a local dev server when the page itself is served locally --
 * a deployed static build goes straight to the in-browser transport.
 */
const WS_URL =
  configuredWsUrl ||
  (DEV_HOSTNAMES.includes(window.location.hostname)
    ? "ws://localhost:3001"
    : "");

/** Keep the view pinned to the newest reply unless the user scrolled away. */
const STICK_TO_BOTTOM_THRESHOLD_PX = 80;

const messagesEl = document.getElementById("messages") as HTMLElement;
const scrollEl = document.querySelector(".chat-container") as HTMLElement | null;
const inputEl = document.getElementById("message-input") as HTMLTextAreaElement;
const sendBtnEl = document.getElementById("send-btn") as HTMLButtonElement;
const statusEl = document.getElementById("ws-status") as HTMLElement;
const retryBtnEl = document.getElementById(
  "retry-btn"
) as HTMLButtonElement | null;

let transport: ChatTransport | null = null;
let connected = false;
let isSending = false;
let bootGeneration = 0;

const messages: Message[] = [];
const activeStreams = new Map<string, ActiveStream>();

function addMessage({
  role,
  content,
  streamId = null,
  isSystem = false,
}: Message): void {
  messages.push({ role, content, streamId, isSystem });
  renderMessages();
}

function renderMessages(): void {
  if (!messagesEl) return;

  // `.chat-container` is the scrolling element -- `.messages` has no overflow,
  // so scrolling it would silently do nothing.
  const stickToBottom = scrollEl ? isNearBottom(scrollEl) : false;
  const previousScrollTop = scrollEl ? scrollEl.scrollTop : 0;

  messagesEl.innerHTML = "";

  messages.forEach((msg) => {
    const row = document.createElement("div");
    row.className =
      "message-row " + (msg.role === "user" ? "user" : "assistant");

    const bubble = document.createElement("div");
    bubble.className =
      "message-bubble " +
      (msg.isSystem ? "system" : msg.role === "user" ? "user" : "assistant");

    if (!msg.isSystem) {
      const roleBadge = document.createElement("div");
      roleBadge.className = "role-badge";
      roleBadge.textContent = msg.role === "user" ? "You" : "Bot";
      bubble.appendChild(roleBadge);
    }

    const content = document.createElement("div");
    content.textContent = msg.content;
    bubble.appendChild(content);

    if (msg.isSystem) {
      row.style.justifyContent = "center";
    }

    row.appendChild(bubble);
    messagesEl.appendChild(row);
  });

  if (scrollEl) {
    // Rebuilding the list collapses the scroll height, so the position has to
    // be restored explicitly for a user who scrolled back through history.
    scrollEl.scrollTop = stickToBottom
      ? scrollEl.scrollHeight
      : previousScrollTop;
  }
}

function isNearBottom(el: HTMLElement): boolean {
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  return distance <= STICK_TO_BOTTOM_THRESHOLD_PX;
}

function setStatus(text: string, mode: string): void {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.remove("online", "offline", "demo");
  if (mode) statusEl.classList.add(mode);
}

function setRetryVisible(visible: boolean): void {
  if (!retryBtnEl) return;
  retryBtnEl.hidden = !visible;
}

function setSending(next: boolean): void {
  isSending = next;
  if (!sendBtnEl) return;
  sendBtnEl.disabled = next || !connected;
  sendBtnEl.textContent = next ? "Waiting for reply..." : "Send";
}

function setConnected(next: boolean): void {
  if (connected === next) return;
  connected = next;

  if (!next && activeStreams.size > 0) {
    addMessage({
      role: "assistant",
      content: "The reply was interrupted because the connection dropped.",
      isSystem: true,
    });
  }

  // A dropped connection used to leave `isSending` stuck on, which blocked
  // every later send even after a successful reconnect.
  activeStreams.clear();
  setSending(false);
}

function handleTransportMessage(msg: WSMessage): void {
  if (msg.type === "system") {
    addMessage({
      role: "assistant",
      content: msg.content || "",
      isSystem: true,
    });
    return;
  }

  if (msg.type === "error") {
    addMessage({
      role: "assistant",
      content: msg.error || "",
      isSystem: true,
    });
    setSending(false);
    return;
  }

  if (msg.type === "chunk" && msg.requestId) {
    const { requestId, content } = msg;
    let current = activeStreams.get(requestId);
    if (!current) {
      current = { index: messages.length, content: "" };
      activeStreams.set(requestId, current);
      messages.push({
        role: "assistant",
        content: "",
        streamId: requestId,
      });
    }
    current.content += content || "";
    messages[current.index].content = current.content;
    renderMessages();
    return;
  }

  if (msg.type === "done" && msg.requestId) {
    activeStreams.delete(msg.requestId);
    if (activeStreams.size === 0) setSending(false);
  }
}

function handleTransportState(
  state: TransportState,
  kind: TransportKind
): void {
  switch (state) {
    case "connecting":
      setConnected(false);
      setStatus("Connecting...", "");
      setRetryVisible(false);
      break;
    case "open":
      setConnected(true);
      setStatus(
        kind === "local" ? "Demo mode" : "Online",
        kind === "local" ? "demo" : "online"
      );
      setRetryVisible(false);
      break;
    case "reconnecting":
      setConnected(false);
      setStatus("Offline (reconnecting...)", "offline");
      setRetryVisible(false);
      break;
    case "unavailable":
      setConnected(false);
      setStatus("Server unavailable", "offline");
      setRetryVisible(true);
      break;
  }
}

const handlers: TransportHandlers = {
  onMessage: handleTransportMessage,
  onStateChange: handleTransportState,
};

/**
 * Picks a transport: the configured WebSocket server when it answers, and the
 * in-browser transport otherwise, so the streaming UI always has something to
 * stream instead of stalling on a permanent "connecting" pill.
 */
async function boot(): Promise<void> {
  const generation = ++bootGeneration;

  if (transport) {
    transport.dispose();
    transport = null;
  }

  setConnected(false);
  setRetryVisible(false);
  setStatus("Connecting...", "");

  if (WS_URL) {
    const socketTransport = new WebSocketTransport(WS_URL, handlers);
    const opened = await socketTransport.start(OPEN_TIMEOUT_MS);

    if (generation !== bootGeneration) {
      socketTransport.dispose();
      return;
    }

    if (opened) {
      transport = socketTransport;
      return;
    }

    socketTransport.dispose();
  }

  const localTransport = new LocalTransport(handlers);
  transport = localTransport;
  localTransport.start();
}

function handleSend(): void {
  if (isSending || activeStreams.size > 0 || !inputEl) return;

  const text = inputEl.value.trim();
  if (!text) return;

  inputEl.value = "";
  inputEl.style.height = "auto";

  addMessage({ role: "user", content: text });

  if (!transport || !transport.isOpen) {
    addMessage({
      role: "assistant",
      content:
        "No connection to the server. Please wait for reconnection and try again.",
      isSystem: true,
    });
    return;
  }

  setSending(true);

  if (!transport.send({ type: "message", content: text })) {
    addMessage({
      role: "assistant",
      content: "Failed to send message to the server. Please try again.",
      isSystem: true,
    });
    setSending(false);
  }
}

if (sendBtnEl) {
  sendBtnEl.addEventListener("click", (e) => {
    e.preventDefault();
    handleSend();
  });
}

if (retryBtnEl) {
  retryBtnEl.addEventListener("click", () => {
    void boot();
  });
}

if (inputEl) {
  const updatePlaceholder = () => {
    if (window.innerWidth <= 480) {
      inputEl.placeholder = "Type a message...";
    } else {
      inputEl.placeholder = "Type a message and press Enter...";
    }
  };

  updatePlaceholder();
  window.addEventListener("resize", updatePlaceholder);

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      handleSend();
    }
  });

  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 140)}px`;
  });
}

void boot();
