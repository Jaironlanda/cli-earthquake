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

/* global Terminal, FitAddon */

const PROMPT = "\x1b[1;36mearthquake\x1b[0m \x1b[2m$\x1b[0m ";

const term = new Terminal({
	cursorBlink: true,
	fontFamily:
		'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
	fontSize: 14,
	theme: {
		background: "#0b0f14",
		foreground: "#c8d3df",
		cursor: "#35c1e8",
		selectionBackground: "#24405299",
	},
	scrollback: 5000,
});

const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById("terminal"));
fitAddon.fit();

// Refit on resize (and after the browser settles layout on load).
const refit = () => {
	try {
		fitAddon.fit();
	} catch {
		/* terminal not yet visible */
	}
};
window.addEventListener("resize", refit);

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

function connect() {
	const proto = location.protocol === "https:" ? "wss:" : "ws:";
	setStatus("connecting", greeted ? "reconnecting…" : "connecting…");
	ws = new WebSocket(`${proto}//${location.host}/ws`);

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
			newPrompt();
			break;
		case "output":
		case "error":
			term.write("\r\n" + msg.text + "\r\n\r\n");
			// Phase 6: row-returning commands carry a GeoJSON set; replot the map.
			if (msg.mapData) window.EarthquakeMap?.setFeatures(msg.mapData);
			busy = false;
			newPrompt();
			break;
		case "alert":
			// Real-time push (Phase 5): can arrive at any moment, including
			// mid-typing. Drop to a fresh line, print the banner, then restore
			// the prompt + whatever the user had half-typed. While a command is
			// in flight (busy) its own reply will redraw the prompt, so we skip
			// the restore to avoid a stray prompt above the pending output.
			term.write("\r\n" + msg.text + "\r\n\r\n");
			// Phase 6: upsert the new quakes onto the map without clearing it.
			if (msg.mapData) window.EarthquakeMap?.addFeatures(msg.mapData);
			if (!busy && greeted) render();
			break;
		default:
			// Unknown future message types are ignored.
			break;
	}
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

term.focus();
connect();
