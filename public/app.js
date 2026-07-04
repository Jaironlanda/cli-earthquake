/*
 * Earthquake CLI — terminal frontend (Phase 4).
 *
 * Wires an xterm.js terminal to the `/ws` WebSocket backend (the TerminalHub
 * Durable Object). xterm.js is a dumb display surface: it has no shell, REPL, or
 * line editor of its own, so we own the prompt loop here. We buffer keystrokes
 * into a line, handle Enter / Backspace / cursor movement / history, and only
 * ship a completed line to the server as {type:"input",line}. Server replies
 * ({welcome|output|error}) carry ANSI, which xterm renders natively via write().
 */

/* global Terminal, FitAddon, WebLinksAddon */

const PROMPT = "\x1b[1;36mearthquake\x1b[0m \x1b[2m$\x1b[0m ";

const term = new Terminal({
	cursorBlink: true,
	fontFamily:
		'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
	fontSize: 14,
	// The terminal floats over the full-screen map as a translucent window;
	// its own background stays fully transparent so the glass effect (rgba +
	// backdrop blur on .term-window) is what tints the map behind the text.
	allowTransparency: true,
	theme: {
		background: "rgba(0, 0, 0, 0)",
		foreground: "#c8d3df",
		cursor: "#35c1e8",
		selectionBackground: "#24405299",
	},
	scrollback: 5000,
});

const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
// Makes URLs in terminal output (e.g. the banner's author link) clickable.
term.loadAddon(new WebLinksAddon.WebLinksAddon());
term.open(document.getElementById("terminal"));
fitAddon.fit();

// Refit on resize (and after the browser settles layout on load). The window
// can also change size without a viewport resize (maximize/restore), so a
// ResizeObserver on the terminal container catches those too.
const refit = () => {
	try {
		fitAddon.fit();
	} catch {
		/* terminal not yet visible */
	}
};
window.addEventListener("resize", refit);
new ResizeObserver(refit).observe(document.getElementById("terminal"));

// --- Line-editing state ----------------------------------------------------

let line = ""; // the line currently being typed
let cursor = 0; // insertion index within `line`
let busy = false; // true while a submitted command awaits its reply
const history = []; // past command lines, oldest first
let historyIndex = -1; // -1 = editing a fresh line; else index into `history`
let draft = ""; // stashed in-progress line while browsing history

/** Write the prompt and reset the line buffer for fresh input. */
function newPrompt() {
	line = "";
	cursor = 0;
	historyIndex = -1;
	draft = "";
	term.write(PROMPT);
}

/**
 * Redraw the current input line in place: return to column 0, rewrite the
 * prompt, clear to end of line, print the buffer, then park the cursor at its
 * logical position. Handles inserts, deletes, and history recall uniformly.
 */
function render() {
	term.write("\r" + PROMPT + "\x1b[K" + line);
	const back = line.length - cursor;
	if (back > 0) term.write(`\x1b[${back}D`);
}

/** Replace the whole line (used by history navigation) and redraw. */
function setLine(next) {
	line = next;
	cursor = next.length;
	render();
}

// --- WebSocket -------------------------------------------------------------

const statusEl = document.getElementById("status");
function setStatus(state, label) {
	statusEl.className = `status status--${state}`;
	statusEl.querySelector(".status__label").textContent = label;
}

let ws = null;
let reconnectDelay = 500; // exponential backoff, capped
let greeted = false; // have we shown at least one prompt yet?

// The browser's IANA timezone (e.g. "Asia/Kuala_Lumpur"), sent with the
// connection so the server renders every timestamp — welcome banner, command
// output, alerts — in this viewer's local time instead of UTC.
let userTimeZone = "";
try {
	userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
} catch {
	/* no Intl timezone support — the server falls back to UTC */
}

function connect() {
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	setStatus("connecting", greeted ? "reconnecting…" : "connecting…");
	const tzParam = userTimeZone ? `?tz=${encodeURIComponent(userTimeZone)}` : "";
	ws = new WebSocket(`${proto}//${location.host}/ws${tzParam}`);

	ws.onopen = () => {
		reconnectDelay = 500;
		setStatus("open", "connected");
	};

	ws.onmessage = (event) => {
		let msg;
		try {
			msg = JSON.parse(event.data);
		} catch {
			return; // ignore non-JSON frames
		}
		handleServerMessage(msg);
	};

	ws.onclose = () => {
		setStatus("closed", "disconnected — retrying");
		busy = false;
		ws = null;
		setTimeout(connect, reconnectDelay);
		reconnectDelay = Math.min(reconnectDelay * 2, 8000);
	};

	ws.onerror = () => {
		// onclose fires next and drives the reconnect; nothing to do here.
	};
}

/**
 * Render a server message into the terminal. `welcome` greets on (re)connect;
 * `output`/`error` are command results. Each ends by dropping a fresh prompt,
 * which also releases the `busy` lock so the user can type again.
 */
function handleServerMessage(msg) {
	if (!msg || typeof msg.text !== "string") return;

	switch (msg.type) {
		case "welcome":
			// A reconnect shouldn't clobber a half-typed line; only greet once.
			if (greeted) return;
			greeted = true;
			term.write(msg.text + "\r\n\r\n");
			// The welcome banner carries this year's quakes as GeoJSON, so the
			// map shows markers as soon as the site opens.
			if (msg.mapData) window.EarthquakeMap?.setFeatures(msg.mapData);
			newPrompt();
			break;
		case "output":
		case "error":
			term.write("\r\n" + msg.text + "\r\n\r\n");
			// Phase 6: row-returning commands carry a GeoJSON set; replot the map.
			if (msg.mapData) window.EarthquakeMap?.setFeatures(msg.mapData);
			busy = false;
			newPrompt();
			// Map-driven commands: fade the window to a ghost (90% transparent)
			// so the plotted result shows through; clicking or typing in the
			// terminal brings it back.
			if (msg.mapData?.features?.length) setGhost(true);
			break;
		case "download":
			// Phase 7: `export` result. xterm.js has no file I/O, so we save the
			// content client-side via a Blob, then print the confirmation text and
			// drop a fresh prompt (this frame stands in for the output frame).
			saveFile(msg.filename, msg.mime, msg.content);
			term.write("\r\n" + msg.text + "\r\n\r\n");
			busy = false;
			newPrompt();
			break;
		case "alert":
			// Real-time push (Phase 5): can arrive at any moment, including
			// mid-typing. Drop to a fresh line, print the banner, then restore
			// the prompt + whatever the user had half-typed. While a command is
			// in flight (busy) its own reply will redraw the prompt, so we skip
			// the restore to avoid a stray prompt above the pending output.
			// Phase 8: significant quakes set `bell` — ring the terminal bell.
			term.write("\r\n" + (msg.bell ? "\x07" : "") + msg.text + "\r\n\r\n");
			// Phase 6: upsert the new quakes onto the map without clearing it.
			if (msg.mapData) window.EarthquakeMap?.addFeatures(msg.mapData);
			if (!busy && greeted) render();
			// A ghosted window would hide the banner; bring it back.
			setGhost(false);
			// If the window is minimized the user can't see the banner; pulse the
			// dock chip until they restore the terminal.
			if (winEl.classList.contains("minimized"))
				dockEl.classList.add("term-dock--alert");
			break;
		default:
			// Unknown future message types are ignored.
			break;
	}
}

/**
 * Trigger a browser download of `content` (Phase 7). xterm.js can't write
 * files, so we wrap the text in a Blob, point a hidden <a download> at an object
 * URL, click it, and revoke the URL afterwards.
 */
function saveFile(filename, mime, content) {
	if (typeof content !== "string") return;
	const blob = new Blob([content], { type: mime || "application/octet-stream" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename || "earthquakes.txt";
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}

/** Send the completed line to the backend and enter the busy state. */
function submit() {
	const value = line.trim();
	term.write("\r\n");

	if (value === "") {
		newPrompt();
		return;
	}

	// De-dupe consecutive identical history entries.
	if (history[history.length - 1] !== value) history.push(value);

	// `clear`/`cls` is handled locally for an instant, top-anchored redraw with
	// no round trip (and it works even while disconnected). It's still declared
	// in the server command registry so `help` documents it; raw ws clients get
	// the same clear via a returned ANSI sequence.
	const cmd = value.toLowerCase();
	if (cmd === "clear" || cmd === "cls") {
		term.write("\x1b[2J\x1b[3J\x1b[H"); // clear screen + scrollback + home
		newPrompt();
		return;
	}

	if (!ws || ws.readyState !== WebSocket.OPEN) {
		term.write("\x1b[31mNot connected — command not sent.\x1b[0m\r\n\r\n");
		newPrompt();
		return;
	}

	busy = true;
	ws.send(JSON.stringify({ type: "input", line: value }));
}

// --- Key handling ----------------------------------------------------------

term.onData((data) => {
	// Typing means the user wants the terminal back — drop any ghost fade.
	setGhost(false);

	// While a command is in flight, swallow input except Ctrl+C (cancel).
	if (busy) {
		if (data === "\x03") {
			busy = false;
			term.write("^C\r\n");
			newPrompt();
		}
		return;
	}

	switch (data) {
		case "\r": // Enter
			submit();
			return;

		case "\x7f": // Backspace
		case "\b":
			if (cursor > 0) {
				line = line.slice(0, cursor - 1) + line.slice(cursor);
				cursor--;
				render();
			}
			return;

		case "\x03": // Ctrl+C — abandon the current line
			term.write("^C\r\n");
			newPrompt();
			return;

		case "\x0c": // Ctrl+L — clear screen, keep the current line
			term.write("\x1b[2J\x1b[H");
			render();
			return;

		case "\x1b[A": // Up — older history
			if (history.length === 0) return;
			if (historyIndex === -1) {
				draft = line;
				historyIndex = history.length - 1;
			} else if (historyIndex > 0) {
				historyIndex--;
			}
			setLine(history[historyIndex]);
			return;

		case "\x1b[B": // Down — newer history (or back to the draft)
			if (historyIndex === -1) return;
			if (historyIndex < history.length - 1) {
				historyIndex++;
				setLine(history[historyIndex]);
			} else {
				historyIndex = -1;
				setLine(draft);
			}
			return;

		case "\x1b[C": // Right
			if (cursor < line.length) {
				cursor++;
				term.write("\x1b[C");
			}
			return;

		case "\x1b[D": // Left
			if (cursor > 0) {
				cursor--;
				term.write("\x1b[D");
			}
			return;

		case "\x1b[H": // Home
		case "\x01": // Ctrl+A
			if (cursor > 0) {
				term.write(`\x1b[${cursor}D`);
				cursor = 0;
			}
			return;

		case "\x1b[F": // End
		case "\x05": // Ctrl+E
			if (cursor < line.length) {
				term.write(`\x1b[${line.length - cursor}C`);
				cursor = line.length;
			}
			return;

		case "\x15": // Ctrl+U — clear the whole line
			line = "";
			cursor = 0;
			render();
			return;

		default:
			// Printable input (including pasted text). Reject control chars so a
			// stray escape sequence can't corrupt the buffer.
			if (data >= " " || data === "\t") {
				const clean = data.replace(/[\r\n]/g, "");
				line = line.slice(0, cursor) + clean + line.slice(cursor);
				cursor += clean.length;
				render();
			}
			return;
	}
});

// --- Window manager ----------------------------------------------------------
//
// The terminal is a floating Linux-style window over the full-screen map:
// draggable by its titlebar, minimizable to a dock chip, maximizable to the
// viewport. All geometry is CSS; this block only toggles classes, moves the
// window while dragging, and hands drag offsets back before maximizing (the
// .maximized class pins to the viewport edges, so inline positions must go).

const winEl = document.getElementById("term-window");
const titlebarEl = document.getElementById("term-titlebar");
const btnMin = document.getElementById("term-min");
const btnMax = document.getElementById("term-max");
const dockEl = document.getElementById("term-dock");

/** Saved inline position (from dragging) so restore puts the window back. */
let savedPosition = null;

function isMaximized() {
	return winEl.classList.contains("maximized");
}

function setMaximized(on) {
	if (on) {
		savedPosition = {
			left: winEl.style.left,
			top: winEl.style.top,
			bottom: winEl.style.bottom,
			transform: winEl.style.transform,
		};
		winEl.style.left = "";
		winEl.style.top = "";
		winEl.style.bottom = "";
		winEl.style.transform = "";
		winEl.classList.add("maximized");
	} else {
		winEl.classList.remove("maximized");
		if (savedPosition) {
			winEl.style.left = savedPosition.left;
			winEl.style.top = savedPosition.top;
			winEl.style.bottom = savedPosition.bottom;
			winEl.style.transform = savedPosition.transform;
		}
	}
	btnMax.textContent = on ? "❐" : "□";
	btnMax.title = on ? "Restore" : "Maximize";
	btnMax.setAttribute(
		"aria-label",
		on ? "Restore terminal" : "Maximize terminal",
	);
	term.focus();
}

function minimize() {
	winEl.classList.add("minimized");
	dockEl.classList.add("visible");
}

function restoreFromDock() {
	winEl.classList.remove("minimized");
	setGhost(false);
	dockEl.classList.remove("visible", "term-dock--alert");
	term.focus();
}

/**
 * Ghost mode: after a map-plotting command the window fades to 90%
 * transparency (CSS .ghost) so the result shows through it. Hover previews it
 * (CSS); clicking or typing in the terminal restores it for good.
 */
function setGhost(on) {
	winEl.classList.toggle("ghost", on);
}

winEl.addEventListener("pointerdown", () => setGhost(false));

// Interacting with the map tucks the terminal away so it never blocks the view;
// the dock chip (top-center) brings it back.
document.getElementById("map").addEventListener("pointerdown", () => {
	if (!winEl.classList.contains("minimized")) minimize();
});

btnMax.addEventListener("click", () => setMaximized(!isMaximized()));
btnMin.addEventListener("click", minimize);
dockEl.addEventListener("click", restoreFromDock);

// Double-click the titlebar (not its buttons) to toggle maximize, like most
// Linux window managers.
titlebarEl.addEventListener("dblclick", (e) => {
	if (e.target.closest("button, a")) return;
	setMaximized(!isMaximized());
});

// Drag by the titlebar. On drag start the window switches from the centered
// transform to explicit left/top pixels (captured from its current rect), so
// moving it is just updating those two values, clamped to the viewport.
let drag = null;

/** Position the window, keeping enough of the titlebar on-screen to grab. */
function moveTo(x, y) {
	winEl.style.left = `${Math.min(
		Math.max(x, 120 - winEl.offsetWidth),
		window.innerWidth - 120,
	)}px`;
	winEl.style.top = `${Math.min(Math.max(y, 0), window.innerHeight - 40)}px`;
}

// A dragged window could be stranded outside a shrinking viewport; re-clamp
// whenever the browser resizes (centered/maximized windows need no help).
window.addEventListener("resize", () => {
	if (winEl.style.left && !isMaximized()) {
		moveTo(parseFloat(winEl.style.left), parseFloat(winEl.style.top));
	}
});

titlebarEl.addEventListener("pointerdown", (e) => {
	if (e.target.closest("button, a") || isMaximized()) return;
	const rect = winEl.getBoundingClientRect();
	drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
	winEl.style.left = `${rect.left}px`;
	winEl.style.top = `${rect.top}px`;
	winEl.style.bottom = "auto"; // top anchors while dragging
	winEl.style.transform = "none";
	titlebarEl.setPointerCapture(e.pointerId);
});

titlebarEl.addEventListener("pointermove", (e) => {
	if (!drag) return;
	moveTo(e.clientX - drag.dx, e.clientY - drag.dy);
});

const endDrag = () => {
	drag = null;
};
titlebarEl.addEventListener("pointerup", endDrag);
titlebarEl.addEventListener("pointercancel", endDrag);

// --- Help / guide modal --------------------------------------------------------
//
// A plain-language walkthrough for non-technical visitors: opened by the ?
// titlebar button, shown automatically on the first visit (localStorage flag),
// closed via ×, Esc, or clicking the backdrop.

const helpModal = document.getElementById("help-modal");
const GUIDE_SEEN_KEY = "eq-guide-seen";

function openHelp() {
	helpModal.hidden = false;
}

function closeHelp() {
	helpModal.hidden = true;
	try {
		localStorage.setItem(GUIDE_SEEN_KEY, "1");
	} catch {
		/* storage blocked (private mode) — the guide just reopens next visit */
	}
	term.focus();
}

document.getElementById("term-help").addEventListener("click", openHelp);
document.getElementById("help-close").addEventListener("click", closeHelp);
helpModal.addEventListener("click", (e) => {
	if (e.target === helpModal) closeHelp(); // backdrop click, not the card
});
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && !helpModal.hidden) closeHelp();
});

try {
	if (!localStorage.getItem(GUIDE_SEEN_KEY)) openHelp();
} catch {
	/* storage blocked — don't auto-open on every visit, the ? button remains */
}

term.focus();
connect();
