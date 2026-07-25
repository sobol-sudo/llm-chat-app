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

/**
 * How long a reply may be silent -- before its first chunk or between two of
 * them -- before the app stops claiming one is on its way. Both transports
 * chunk every 80ms, so this only ever fires on a server that has genuinely
 * stopped answering.
 */
const REPLY_SILENCE_TIMEOUT_MS = 20000;

const MAX_INPUT_HEIGHT_PX = 140;

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

/** Deadline for the reply currently being waited on, if any. */
let replyTimer: number | null = null;

/** Last lifecycle state reported by a transport; drives what a send does. */
let transportState: TransportState = "connecting";

/** True while a WebSocket URL is configured but the in-browser transport is carrying the chat. */
let usingFallback = false;

/**
 * A message typed before the transport was ready. Exactly one may wait at a
 * time; it is flushed on `open` and handed back to the composer if the
 * connection turns out to be a dead end, so a send is never lost silently.
 */
let queuedText: string | null = null;

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

/** Adds a system line, skipping an immediate repeat of the same text. */
function notify(content: string): void {
  const last = messages[messages.length - 1];
  if (last && last.isSystem && last.content === content) return;
  addMessage({ role: "assistant", content, isSystem: true });
}

function buildMessageRow(msg: Message): HTMLElement {
  const row = document.createElement("div");
  row.className = "message-row " + (msg.role === "user" ? "user" : "assistant");

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
  return row;
}

/**
 * The transcript is empty until the transport says something, so the chat area
 * would otherwise be a blank panel for the whole connection attempt.
 */
function buildEmptyState(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "empty-state";

  const title = document.createElement("div");
  title.className = "empty-state-title";
  title.textContent = "No messages yet";
  wrap.appendChild(title);

  const body = document.createElement("p");
  body.className = "empty-state-body";
  body.textContent =
    "Send a message to watch the answer stream back in chunks over the chat protocol.";
  wrap.appendChild(body);

  const note = document.createElement("p");
  note.className = "empty-state-note";
  note.textContent =
    "Replies are generated placeholder text, not model output.";
  wrap.appendChild(note);

  return wrap;
}

/** The waiting message, drawn as a real bubble so it is never invisible. */
function buildQueuedRow(text: string): HTMLElement {
  const row = buildMessageRow({ role: "user", content: text });
  const bubble = row.firstElementChild as HTMLElement | null;
  if (bubble) bubble.classList.add("pending");

  const note = document.createElement("div");
  note.className = "message-note";
  note.textContent = "Queued - will send as soon as the connection is ready";
  bubble?.appendChild(note);

  return row;
}

function renderMessages(): void {
  if (!messagesEl) return;

  // `.chat-container` is the scrolling element -- `.messages` has no overflow,
  // so scrolling it would silently do nothing.
  const stickToBottom = scrollEl ? isNearBottom(scrollEl) : false;
  const previousScrollTop = scrollEl ? scrollEl.scrollTop : 0;

  messagesEl.innerHTML = "";

  if (messages.length === 0 && queuedText === null) {
    messagesEl.appendChild(buildEmptyState());
  } else {
    messages.forEach((msg) => messagesEl.appendChild(buildMessageRow(msg)));
    if (queuedText !== null) {
      messagesEl.appendChild(buildQueuedRow(queuedText));
    }
  }

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

/**
 * Retry re-runs the whole boot sequence against the configured server, so it
 * is offered whenever such a server exists and is not currently carrying the
 * chat -- both after the retry budget runs out and while the in-browser
 * fallback stands in for an unreachable one.
 */
function updateRetry(): void {
  if (!retryBtnEl) return;

  const offerRetry =
    Boolean(WS_URL) && (transportState === "unavailable" || usingFallback);

  retryBtnEl.hidden = !offerRetry;
  retryBtnEl.textContent = "Retry server";
  retryBtnEl.title = WS_URL ? `Try connecting to ${WS_URL} again` : "";
}

/** What pressing Send will actually do right now, for the button's tooltip. */
function composerHint(): string {
  if (queuedText !== null) return "A message is already waiting to be sent";
  if (isSending) return "Waiting for the current reply to finish";
  if (connected) return "Send the message";
  if (transportState === "unavailable") {
    return 'The server is unavailable - press "Retry server", then send again';
  }
  return "Not connected yet: the message is queued and sent on its own";
}

/**
 * The button is disabled only in the two states whose label explains the wait
 * -- a reply in flight, or a message already queued. Being unconnected is not
 * one of them: a send is then queued or refused with a system line, so the
 * outcome is defined and the control must stay live. Disabling it there left
 * pointer and touch users, who have no Enter key, with a grey button and no
 * way to reach any of that.
 */
function updateComposer(): void {
  if (!sendBtnEl) return;

  sendBtnEl.disabled = isSending || queuedText !== null;
  sendBtnEl.textContent =
    queuedText !== null
      ? "Queued..."
      : isSending
        ? "Waiting for reply..."
        : "Send";
  sendBtnEl.title = composerHint();
}

function clearReplyWatchdog(): void {
  if (replyTimer === null) return;
  window.clearTimeout(replyTimer);
  replyTimer = null;
}

/**
 * A socket can stay open while the server behind it stops answering: no close
 * event, no error, just silence. Without a deadline the composer would sit on
 * "Waiting for reply..." for good under an "Online" pill -- alive-looking and
 * unusable. The wait is bounded instead, and what was already received stays
 * in the transcript.
 */
function armReplyWatchdog(): void {
  clearReplyWatchdog();

  replyTimer = window.setTimeout(() => {
    replyTimer = null;
    if (!isSending && activeStreams.size === 0) return;

    const startedStreaming = activeStreams.size > 0;
    activeStreams.clear();
    setSending(false);

    notify(
      startedStreaming
        ? "The reply stopped part-way through and the server went quiet. " +
            "What arrived is kept above - you can send another message."
        : "No reply came back within 20 seconds, although the connection is " +
            "still open. You can send another message."
    );
  }, REPLY_SILENCE_TIMEOUT_MS);
}

function setSending(next: boolean): void {
  isSending = next;

  if (next) {
    armReplyWatchdog();
  } else {
    clearReplyWatchdog();
  }

  updateComposer();
}

function setConnected(next: boolean): void {
  if (connected === next) {
    updateComposer();
    return;
  }
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

function resetInputHeight(): void {
  if (!inputEl) return;
  inputEl.style.height = "auto";
}

function growInput(): void {
  if (!inputEl) return;
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, MAX_INPUT_HEIGHT_PX)}px`;
}

/** Puts text the app refused to send back where the user can edit and resend it. */
function restoreToComposer(text: string): void {
  if (!inputEl) return;
  inputEl.value = inputEl.value ? `${text}\n${inputEl.value}` : text;
  growInput();
  inputEl.focus();
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
    // The server has given up on the request, so nothing is streaming any
    // more. Leaving the stream open would refuse every later send with
    // "a reply is still streaming" while no reply was ever coming.
    activeStreams.clear();
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
    // Progress: the server is still talking, so the silence deadline restarts.
    armReplyWatchdog();
    renderMessages();
    return;
  }

  if (msg.type === "done" && msg.requestId) {
    activeStreams.delete(msg.requestId);
    if (activeStreams.size === 0) setSending(false);
    else armReplyWatchdog();
  }
}

/** Sends the waiting message now that a transport is open. */
function flushQueue(): void {
  if (queuedText === null) return;
  if (!transport || !transport.isOpen) return;

  const text = queuedText;

  if (!transport.send({ type: "message", content: text })) {
    queuedText = null;
    restoreToComposer(text);
    updateComposer();
    notify(
      "The queued message could not be sent. It is back in the composer - try again."
    );
    return;
  }

  queuedText = null;
  addMessage({ role: "user", content: text });
  setSending(true);
}

/** Gives the waiting message back to the user when nothing will ever flush it. */
function dropQueue(reason: string): void {
  if (queuedText === null) return;

  const text = queuedText;
  queuedText = null;
  restoreToComposer(text);
  updateComposer();
  notify(reason);
}

function handleTransportState(
  state: TransportState,
  kind: TransportKind
): void {
  transportState = state;

  switch (state) {
    case "connecting":
      setConnected(false);
      setStatus("Connecting...", "");
      break;
    case "open":
      setConnected(true);
      if (kind === "local") {
        setStatus(
          usingFallback ? "Demo mode - server unreachable" : "Demo mode",
          "demo"
        );
      } else {
        setStatus("Online", "online");
      }
      break;
    case "reconnecting":
      setConnected(false);
      setStatus("Offline (reconnecting...)", "offline");
      break;
    case "unavailable":
      setConnected(false);
      setStatus("Server unavailable", "offline");
      break;
  }

  updateRetry();
  updateComposer();

  if (state === "open") {
    flushQueue();
    return;
  }

  if (state === "unavailable") {
    dropQueue(
      "The server is unavailable, so the queued message was not sent. " +
        'It is back in the composer - press "Retry server" and send it again.'
    );
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
 *
 * A configured server that does not answer is reported in the transcript and
 * leaves the Retry control on screen: falling back has to look like a
 * degradation, not like a deliberate demo.
 */
async function boot(): Promise<void> {
  const generation = ++bootGeneration;

  if (transport) {
    transport.dispose();
    transport = null;
  }

  usingFallback = false;
  transportState = "connecting";
  setConnected(false);
  setStatus("Connecting...", "");
  updateRetry();
  renderMessages();

  if (WS_URL) {
    const socketTransport = new WebSocketTransport(WS_URL, handlers);
    // Assigned before the attempt so the `open` handler -- which fires from
    // inside `start()` -- already has a transport to flush the queue through.
    transport = socketTransport;

    const opened = await socketTransport.start(OPEN_TIMEOUT_MS);

    if (generation !== bootGeneration) {
      socketTransport.dispose();
      return;
    }

    if (opened) return;

    if (transport === socketTransport) transport = null;
    socketTransport.dispose();

    usingFallback = true;
    notify(
      `Could not reach the WebSocket server at ${WS_URL}. ` +
        (configuredWsUrl
          ? "Check that WS_URL points at a running server. "
          : "Start the server in /backend to stream from it. ") +
        "Falling back to the in-browser demo transport."
    );
  }

  const localTransport = new LocalTransport(handlers);
  transport = localTransport;
  localTransport.start();
}

function handleSend(): void {
  if (!inputEl) return;

  const text = inputEl.value.trim();
  if (!text) return;

  if (isSending || activeStreams.size > 0) {
    notify(
      "A reply is still streaming. Wait for it to finish, then send this message."
    );
    return;
  }

  if (queuedText !== null) {
    notify(
      "A message is already waiting for the connection. It will send first."
    );
    return;
  }

  // Not ready yet. Queue it while an attempt is genuinely in flight; refuse it
  // outright once no attempt is left to flush it. Either way the text survives.
  if (!transport || !transport.isOpen) {
    if (transportState === "unavailable") {
      notify(
        'Not sent: the server is unavailable. Press "Retry server", then send again.'
      );
      return;
    }

    inputEl.value = "";
    resetInputHeight();
    inputEl.focus();
    queuedText = text;
    updateComposer();
    renderMessages();
    return;
  }

  // Commit to the transcript only once the transport has accepted the message,
  // so a failed send leaves the text in the composer instead of an orphan turn.
  if (!transport.send({ type: "message", content: text })) {
    notify(
      "Failed to send the message. It is still in the composer - please try again."
    );
    return;
  }

  inputEl.value = "";
  resetInputHeight();
  // Clicking the button moves focus off the composer; put it back so the next
  // message can be typed straight away, exactly as after pressing Enter.
  inputEl.focus();
  addMessage({ role: "user", content: text });
  setSending(true);
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

  inputEl.addEventListener("input", growInput);
}

updateComposer();
updateRetry();
renderMessages();

void boot();
