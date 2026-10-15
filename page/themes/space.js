// The engine's space theme, the one a station shows unless its config chooses
// another: a starfield behind the decks, and windows to space where now and
// then a planet drifts past. It is also the reference for writing a theme.
//
// A theme is a script published next to the station page. It calls
// registerTheme(name, spec) once; the page then offers it in CONFIGURE under
// THEME, by its label. Every field of spec is optional:
//
//   label        the theme's name in CONFIGURE, in English
//   css          styles, every rule under body[data-theme="<name>"], so they
//                apply only while the theme is chosen
//   backdrop()   returns the node drawn behind the decks
//   window(f)    returns the window of the room of folder f; keep the classes
//                "porthole" and "mullion" so it takes the station's frame
//   ambient      overrides for the shared rooms, by key ("#canteen",
//                "#hangar"): name, sub, wall, lights, items (the hangar's
//                first items must stay its pads)
//   furniture    extra furniture, by key: { rows, pal, label }
//   es           the Spanish of the theme's texts, keyed by their English
//
// A theme may use the page's helpers: el(tag, attrs, ...children) builds an
// element, spr(rows, pal, scale) draws a pixel sprite, hashOf(text) gives a
// stable number in [0, 1), starsSvg(w, h, seed, n) draws a starfield,
// dayPhase() is "dawn", "day", "dusk" or "night" by the local hour, and INK is
// the outline colour. A theme changes only the scenery: never the robots, the
// rooms or what the page does.
(() => {
const css = `
body[data-theme="space"] .planet { position: absolute; left: -40px; z-index: 1; border-radius: 50%; background: radial-gradient(circle at 34% 32%, var(--p1) 0, var(--p2) 72%); box-shadow: 0 0 8px var(--p1); animation: planet-drift linear infinite; }
@keyframes planet-drift { 0% { transform: translateX(0) } 60% { transform: translateX(220px) } 100% { transform: translateX(220px) } }
body[data-theme="space"].no-motion .planet { display: none; }
`;

// Light and shadow of each planet a window may show.
const PLANETS = [["#d98b5f", "#5a2e1d"], ["#7fb6e0", "#1d3a5a"], ["#c9b7f0", "#3d2d6b"], ["#9fd6a0", "#22472a"], ["#f0d37f", "#6b4f1d"]];

// Each room gets its own sky, the same on every redraw: everything is drawn
// from hashes of its folder, never at random.
function spaceWindow(folder) {
  const seed = Math.floor(hashOf(folder) * 2147483646) + 1;
  const [light, deep] = PLANETS[Math.floor(hashOf(folder + "planet") * PLANETS.length)];
  const size = 14 + Math.floor(hashOf(folder + "size") * 16);
  return el("div", { class: `porthole ${dayPhase()}`, "aria-hidden": "true" },
    starsSvg(132, 60, seed, 26),
    el("div", { class: "planet", style: {
      "--p1": light, "--p2": deep, width: `${size}px`, height: `${size}px`,
      top: `${8 + Math.floor(hashOf(folder + "y") * 26)}px`,
      animationDuration: `${70 + Math.floor(hashOf(folder + "t") * 80)}s`,
      animationDelay: `${-Math.floor(hashOf(folder + "d") * 120)}s` } }),
    el("div", { class: "mullion" }));
}

registerTheme("space", {
  label: "Space",
  css,
  backdrop: () => starsSvg(1280, 1000, 11, 220),
  window: spaceWindow,
  es: { "Space": "Espacial" },
});
})();
