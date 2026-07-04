/*
 * Earthquake CLI — map panel (Phase 6).
 *
 * A MapLibre GL JS map that plots the current command's result set as circles
 * sized and coloured by magnitude, filling the viewport beneath the floating
 * xterm.js terminal window. The terminal client (public/app.js) drives it
 * entirely through the small
 * `window.EarthquakeMap` API exposed at the bottom of this file:
 *
 *   EarthquakeMap.setFeatures(geojson)  // replace the plotted set + refit view
 *   EarthquakeMap.addFeatures(geojson)  // upsert points (Phase 5 alerts)
 *
 * Basemap: if the Worker's /api/config hands us a Protomaps key we render their
 * hosted dark vector basemap underneath the points; otherwise we degrade to a
 * plain dark canvas so points still plot with zero external dependencies.
 */

/* global maplibregl, basemaps */

const SOURCE_ID = "earthquakes";
const CIRCLE_LAYER = "earthquake-circles";
/** Symbol layer that draws the animated ripple icon under each core dot. */
const RIPPLE_LAYER = "earthquake-ripples";
const RIPPLE_PERIOD_MS = 2600;
/** How far a ripple grows beyond the core dot before fading out (× radius). */
const RIPPLE_SPREAD = 2.4;
/** Canvas size of one pulse icon (device px; rendered at pixelRatio 2). */
const PULSE_SIZE = 128;

/** Severity band colours — single source for MAG_COLOR and the pulse icons. */
const BAND_COLORS = ["#6b7a8d", "#3fb950", "#d29922", "#f85149", "#ff3b30"];

/**
 * Circle colour by magnitude — mirrors the terminal severity bands in
 * src/lib/format.ts (minor/light/moderate/strong/major). `coalesce` maps a
 * null magnitude to -1 so it lands in the "minor" bucket.
 */
const MAG_COLOR = [
	"step",
	["coalesce", ["get", "mag"], -1],
	BAND_COLORS[0], // < 4  minor    (muted gray)
	4,
	BAND_COLORS[1], // 4–5  light    (green)
	5,
	BAND_COLORS[2], // 5–6  moderate (amber)
	6,
	BAND_COLORS[3], // 6–7  strong   (red)
	7,
	BAND_COLORS[4], // 7+   major    (bright red)
];

/** Pick the pulse icon for a feature's severity band (mirrors MAG_COLOR). */
const PULSE_ICON = [
	"step",
	["coalesce", ["get", "mag"], -1],
	"eq-pulse-0",
	4,
	"eq-pulse-1",
	5,
	"eq-pulse-2",
	6,
	"eq-pulse-3",
	7,
	"eq-pulse-4",
];

/** Circle radius grows with magnitude (null → smallest). */
const MAG_RADIUS = [
	"interpolate",
	["linear"],
	["coalesce", ["get", "mag"], 0],
	0,
	3,
	4,
	7,
	6,
	13,
	8,
	22,
];

/** Empty until the map's `load` event fires; then this holds the live map. */
let map = null;
let loaded = false;

/** The full set of plotted features, keyed by id so alerts can upsert. */
const featureById = new Map();

/** Deferred setFeatures payload if a command result beats the map's load. */
let pendingReplace = null;

const EMPTY = { type: "FeatureCollection", features: [] };

/** Build the current FeatureCollection from the id map. */
function collection() {
	return { type: "FeatureCollection", features: [...featureById.values()] };
}

/** Push the current feature set into the map source (no-op until loaded). */
function syncSource() {
	if (!loaded) return;
	const src = map.getSource(SOURCE_ID);
	if (src) src.setData(collection());
}

/**
 * An animated pulse icon (MapLibre StyleImageInterface): two rings, phase-
 * offset by half a period, grow from the core-dot radius out to the icon edge
 * while fading. Only this small canvas redraws each frame — the map style is
 * never mutated, so the layer doesn't flicker. While no features are plotted,
 * render() returns false and the map stops repainting; the next setData wakes
 * it back up.
 */
function makePulseImage(color) {
	return {
		width: PULSE_SIZE,
		height: PULSE_SIZE,
		data: new Uint8Array(PULSE_SIZE * PULSE_SIZE * 4),
		onAdd() {
			const canvas = document.createElement("canvas");
			canvas.width = PULSE_SIZE;
			canvas.height = PULSE_SIZE;
			this.ctx = canvas.getContext("2d", { willReadFrequently: true });
		},
		render() {
			if (featureById.size === 0) return false;
			const ctx = this.ctx;
			const half = PULSE_SIZE / 2;
			const maxR = half - 2;
			// The ring starts at the core dot's edge (1× of the 1+SPREAD total).
			const coreFrac = 1 / (1 + RIPPLE_SPREAD);
			ctx.clearRect(0, 0, PULSE_SIZE, PULSE_SIZE);
			for (let i = 0; i < 2; i++) {
				const t = (performance.now() / RIPPLE_PERIOD_MS + i / 2) % 1;
				const fade = 1 - t;
				ctx.beginPath();
				ctx.arc(half, half, maxR * (coreFrac + (1 - coreFrac) * t), 0, 2 * Math.PI);
				ctx.fillStyle = color;
				ctx.globalAlpha = 0.1 * fade;
				ctx.fill();
				ctx.strokeStyle = color;
				ctx.lineWidth = 3;
				ctx.globalAlpha = 0.7 * fade;
				ctx.stroke();
			}
			ctx.globalAlpha = 1;
			this.data = ctx.getImageData(0, 0, PULSE_SIZE, PULSE_SIZE).data;
			map.triggerRepaint();
			return true;
		},
	};
}

/** Fit the viewport to the given features (skips a single point → gentle ease). */
function fitTo(features) {
	if (!loaded || features.length === 0) return;
	if (features.length === 1) {
		map.easeTo({ center: features[0].geometry.coordinates, zoom: 5 });
		return;
	}
	const bounds = new maplibregl.LngLatBounds();
	for (const f of features) bounds.extend(f.geometry.coordinates);
	map.fitBounds(bounds, { padding: 48, maxZoom: 6, duration: 600 });
}

/** Construct the MapLibre style — Protomaps basemap if keyed, else dark canvas. */
function buildStyle(protomapsKey) {
	if (protomapsKey && typeof basemaps !== "undefined") {
		return {
			version: 8,
			glyphs:
				"https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
			sprite: "https://protomaps.github.io/basemaps-assets/sprites/v4/dark",
			sources: {
				protomaps: {
					type: "vector",
					tiles: [
						`https://api.protomaps.com/tiles/v4/{z}/{x}/{y}.mvt?key=${protomapsKey}`,
					],
					maxzoom: 15,
					attribution:
						'<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
				},
			},
			layers: basemaps.layers("protomaps", basemaps.namedFlavor("dark"), {
				lang: "en",
			}),
		};
	}
	// No key (or the basemaps helper failed to load): a bare dark background.
	return {
		version: 8,
		sources: {},
		layers: [
			{ id: "bg", type: "background", paint: { "background-color": "#0b0f14" } },
		],
	};
}

/** Add the earthquake source, ripple + core layers, and interactions after load. */
function addEarthquakeLayer() {
	map.addSource(SOURCE_ID, { type: "geojson", data: collection() });

	// One animated pulse icon per severity band (see makePulseImage).
	for (let i = 0; i < BAND_COLORS.length; i++) {
		map.addImage(`eq-pulse-${i}`, makePulseImage(BAND_COLORS[i]), {
			pixelRatio: 2,
		});
	}

	// Ripple rings under the core dot. icon-size scales the icon so its outer
	// edge lands at (1 + RIPPLE_SPREAD) × the core dot's circle-radius; the
	// icon renders at pixelRatio 2, so its display half-size is (SIZE/2 − 2)/2.
	map.addLayer({
		id: RIPPLE_LAYER,
		type: "symbol",
		source: SOURCE_ID,
		layout: {
			"icon-image": PULSE_ICON,
			"icon-size": ["*", MAG_RADIUS, (1 + RIPPLE_SPREAD) / ((PULSE_SIZE / 2 - 2) / 2)],
			"icon-allow-overlap": true,
			"icon-ignore-placement": true,
		},
	});

	// Core dot: transparent fill with a magnitude-coloured ring so the basemap
	// shows through.
	map.addLayer({
		id: CIRCLE_LAYER,
		type: "circle",
		source: SOURCE_ID,
		paint: {
			"circle-radius": MAG_RADIUS,
			"circle-color": MAG_COLOR,
			"circle-opacity": 0.28,
			"circle-stroke-width": 1.5,
			"circle-stroke-color": MAG_COLOR,
			"circle-stroke-opacity": 0.9,
		},
	});

	const popup = new maplibregl.Popup({
		closeButton: false,
		closeOnClick: false,
		className: "eq-popup",
	});

	map.on("mouseenter", CIRCLE_LAYER, (e) => {
		map.getCanvas().style.cursor = "pointer";
		const f = e.features[0];
		const p = f.properties;
		const mag = p.mag === null || p.mag === undefined ? "—" : Number(p.mag).toFixed(1);
		popup
			.setLngLat(f.geometry.coordinates)
			.setHTML(
				`<strong>M ${mag}</strong> · ${escapeHtml(p.location)}<br>` +
					`<span class="eq-popup__meta">${escapeHtml(p.time)}` +
					`${p.depth != null ? ` · ${p.depth} km deep` : ""}</span>`,
			)
			.addTo(map);
	});

	map.on("mouseleave", CIRCLE_LAYER, () => {
		map.getCanvas().style.cursor = "";
		popup.remove();
	});
}

/** Minimal HTML escaping for popup text (locations come straight from D1). */
function escapeHtml(s) {
	return String(s ?? "").replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			],
	);
}

/** Fetch config, create the map, and wire up the load handler. */
async function init() {
	let protomapsKey = "";
	try {
		const res = await fetch("/api/config");
		if (res.ok) protomapsKey = (await res.json()).protomapsKey || "";
	} catch {
		/* offline / config unreachable — fall back to the dark canvas */
	}

	map = new maplibregl.Map({
		container: "map",
		style: buildStyle(protomapsKey),
		center: [110, 5], // roughly centred on the Malaysian feed's region
		zoom: 2.4,
		attributionControl: { compact: true },
	});
	map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

	map.on("load", () => {
		addEarthquakeLayer();
		loaded = true;
		if (pendingReplace) {
			const data = pendingReplace;
			pendingReplace = null;
			EarthquakeMap.setFeatures(data);
		}
	});
}

// --- Public API ------------------------------------------------------------

const EarthquakeMap = {
	/** Replace the plotted set with `geojson` and refit the viewport to it. */
	setFeatures(geojson) {
		const fc = geojson && geojson.features ? geojson : EMPTY;
		if (!loaded) {
			pendingReplace = fc;
			return;
		}
		featureById.clear();
		for (const f of fc.features) featureById.set(f.properties.id, f);
		syncSource();
		fitTo(fc.features);
	},

	/** Upsert `geojson` features without clearing existing ones (alerts). */
	addFeatures(geojson) {
		if (!geojson || !geojson.features || geojson.features.length === 0) return;
		if (!loaded) {
			// Merge into whatever replace is pending so nothing is lost pre-load.
			const base = pendingReplace ?? EMPTY;
			pendingReplace = {
				type: "FeatureCollection",
				features: [...base.features, ...geojson.features],
			};
			return;
		}
		for (const f of geojson.features) featureById.set(f.properties.id, f);
		syncSource();
	},
};

window.EarthquakeMap = EarthquakeMap;
init();
