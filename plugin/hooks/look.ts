import type { ThemeSetArgs } from 'claude-code'

// A look the station can give the Claude app: its colours and, if it has one,
// the scene drawn behind the conversation. name is the same as the page's theme
// of that look, so a station's look and its page go together.
export type Look = {
  name: string
  // In English; es is the Spanish, when it differs.
  label: string
  es?: string
  theme: ThemeSetArgs
  // An SVG drawn behind the conversation when theme.backdrop names a scene,
  // which is the look's name: under 131,072 characters, no scripts, animated
  // only with CSS in its own <style>.
  scene?: string
}

// The space look's colours: the page's deep-space blues by night and pale steel
// by day. Generated once with the design system's makeColors (accent #2bb8d4,
// danger #e0564f, success #3fae6e, warning #e09a1f, pro #8f7ae6; dark surfaces
// #07090e #0a0d13 #0e1219 #12161f and text #e3e9f2 #c9d2df #a9b5c9; light
// surfaces #d9e3f0 #e2e9f4 #ebf0f8 and text #0e1420 #2f3a4d #4f5b70), so the
// plugin carries the colours and not the generator. Regenerate them the same
// way rather than editing a value: the names are the design system's own, and a
// wrong one paints nothing and says nothing.
const SPACE_COLORS: ThemeSetArgs['colors'] = {
  "v": 1,
  "id": "mod-theme",
  "label": "Station",
  "inputs": {
    "light": {
      "gray-0": "#ebf0f8",
      "gray-10": "#e2e9f4",
      "gray-20": "#d9e3f0",
      "gray-30": "#d5dfed",
      "gray-40": "#d1dce9",
      "gray-50": "#cdd7e5",
      "gray-60": "#c9d3e1",
      "gray-70": "#c5d0de",
      "gray-80": "#c1ccdb",
      "gray-90": "#bec8d7",
      "gray-100": "#bac4d4",
      "gray-150": "#a7b2c2",
      "gray-200": "#95a0b1",
      "gray-250": "#828ea0",
      "gray-300": "#717c90",
      "gray-350": "#5f6b7f",
      "gray-400": "#4f5b70",
      "gray-450": "#475367",
      "gray-500": "#3f4a5e",
      "gray-550": "#374255",
      "gray-600": "#2f3a4d",
      "gray-650": "#293345",
      "gray-700": "#232d3d",
      "gray-750": "#1e2636",
      "gray-800": "#18202e",
      "gray-810": "#171f2d",
      "gray-820": "#161e2b",
      "gray-830": "#151d2a",
      "gray-840": "#141b29",
      "gray-850": "#131a27",
      "gray-860": "#121926",
      "gray-870": "#111724",
      "gray-880": "#101623",
      "gray-890": "#0f1521",
      "gray-900": "#0e1420",
      "role-accent-50": "#e3f3f6",
      "role-accent-100": "#c2e7f1",
      "role-accent-250": "#5fc2d9",
      "role-accent-300": "#27b6d2",
      "role-accent-400": "#0097b2",
      "role-accent-450": "#0087a0",
      "role-accent-600": "#005a6d",
      "role-accent-700": "#003f4c",
      "role-accent-800": "#00252e",
      "role-accent-850": "#001a1f",
      "role-accent-fill": "#0087a0",
      "role-accent-fill-hover": "#0097b2",
      "role-accent-on": "#000000",
      "role-danger-100": "#f8d7d6",
      "role-danger-250": "#eb9896",
      "role-danger-300": "#e68280",
      "role-danger-400": "#dc524c",
      "role-danger-450": "#c9453f",
      "role-danger-600": "#892d29",
      "role-danger-700": "#611e1b",
      "role-danger-800": "#3a110f",
      "role-danger-fill": "#c9453f",
      "role-danger-fill-hover": "#dc524c",
      "role-danger-on": "#ffffff",
      "role-success-100": "#cce8d4",
      "role-success-250": "#78c794",
      "role-success-400": "#219f5d",
      "role-success-450": "#188f52",
      "role-success-600": "#0d6036",
      "role-success-700": "#0d4325",
      "role-success-800": "#122518",
      "role-success-fill": "#188f52",
      "role-success-fill-hover": "#219f5d",
      "role-success-on": "#000000",
      "role-warning-100": "#f8dca6",
      "role-warning-200": "#f8b325",
      "role-warning-250": "#eba214",
      "role-warning-300": "#d99411",
      "role-warning-600": "#724604",
      "role-warning-700": "#502e02",
      "role-warning-800": "#311a01",
      "role-warning-fill": "#f8b325",
      "role-warning-fill-hover": "#eba214",
      "role-warning-on": "#0e1420",
      "role-pro-100": "#e1daff",
      "role-pro-250": "#b4a4f5",
      "role-pro-300": "#a593ef",
      "role-pro-400": "#876ee8",
      "role-pro-450": "#785be6",
      "role-pro-600": "#5034ac",
      "role-pro-700": "#36227b",
      "role-pro-800": "#20134b",
      "role-pro-fill": "#785be6",
      "role-pro-fill-hover": "#876ee8",
      "role-pro-on": "#ffffff",
      "role-tooltip-bg": "#07090e",
      "role-tooltip-fg": "#ecf1f9",
      "fill-git-added": "#1a8633",
      "fill-git-modified": "#8b751c",
      "text-git-added": "#1e9e3c",
      "text-git-removed": "#cd2054",
      "text-git-modified": "#98801f",
      "text-git-merged": "#8e6bd9",
      "text-git-closed": "#ff3a30",
      "text-git-conflicting": "#c5621b",
      "text-git-draft": "#737373"
    },
    "dark": {
      "gray-0": "#ecf1f9",
      "gray-10": "#eaeff7",
      "gray-20": "#e9eef6",
      "gray-30": "#e7ecf5",
      "gray-40": "#e5ebf4",
      "gray-50": "#e3e9f2",
      "gray-60": "#e1e7f1",
      "gray-70": "#e0e6ef",
      "gray-80": "#dee4ee",
      "gray-90": "#dce3ed",
      "gray-100": "#dae1ec",
      "gray-150": "#d2dae5",
      "gray-200": "#c9d2df",
      "gray-250": "#c1cbd9",
      "gray-300": "#b9c3d4",
      "gray-350": "#b1bcce",
      "gray-400": "#a9b5c9",
      "gray-450": "#949fb2",
      "gray-500": "#7f899a",
      "gray-550": "#6b7484",
      "gray-600": "#58606f",
      "gray-650": "#454c59",
      "gray-700": "#333945",
      "gray-750": "#222732",
      "gray-800": "#12161f",
      "gray-810": "#11151d",
      "gray-820": "#0f131b",
      "gray-830": "#0e1219",
      "gray-840": "#0c1017",
      "gray-850": "#0a0d13",
      "gray-860": "#090c12",
      "gray-870": "#090b11",
      "gray-880": "#080b10",
      "gray-890": "#080a0f",
      "gray-900": "#07090e",
      "role-accent-50": "#e3f3f6",
      "role-accent-100": "#c2e7f1",
      "role-accent-250": "#5fc2d9",
      "role-accent-300": "#27b6d2",
      "role-accent-400": "#0097b2",
      "role-accent-450": "#0087a0",
      "role-accent-600": "#005a6d",
      "role-accent-700": "#003f4c",
      "role-accent-800": "#00252e",
      "role-accent-850": "#001a1f",
      "role-accent-fill": "#0087a0",
      "role-accent-fill-hover": "#0097b2",
      "role-accent-on": "#000000",
      "role-danger-100": "#f8d7d6",
      "role-danger-250": "#eb9896",
      "role-danger-300": "#e68280",
      "role-danger-400": "#dc524c",
      "role-danger-450": "#c9453f",
      "role-danger-600": "#892d29",
      "role-danger-700": "#611e1b",
      "role-danger-800": "#3a110f",
      "role-danger-fill": "#c9453f",
      "role-danger-fill-hover": "#dc524c",
      "role-danger-on": "#ffffff",
      "role-success-100": "#cce8d4",
      "role-success-250": "#78c794",
      "role-success-400": "#219f5d",
      "role-success-450": "#188f52",
      "role-success-600": "#0d6036",
      "role-success-700": "#0d4325",
      "role-success-800": "#122518",
      "role-success-fill": "#188f52",
      "role-success-fill-hover": "#219f5d",
      "role-success-on": "#07090e",
      "role-warning-100": "#f8dca6",
      "role-warning-200": "#f8b325",
      "role-warning-250": "#eba214",
      "role-warning-300": "#d99411",
      "role-warning-600": "#724604",
      "role-warning-700": "#502e02",
      "role-warning-800": "#311a01",
      "role-warning-fill": "#f8b325",
      "role-warning-fill-hover": "#eba214",
      "role-warning-on": "#07090e",
      "role-pro-100": "#e1daff",
      "role-pro-250": "#b4a4f5",
      "role-pro-300": "#a593ef",
      "role-pro-400": "#876ee8",
      "role-pro-450": "#785be6",
      "role-pro-600": "#5034ac",
      "role-pro-700": "#36227b",
      "role-pro-800": "#20134b",
      "role-pro-fill": "#785be6",
      "role-pro-fill-hover": "#876ee8",
      "role-pro-on": "#ffffff",
      "role-tooltip-bg": "#07090e",
      "role-tooltip-fg": "#ecf1f9",
      "fill-git-added": "#32d74b",
      "fill-git-modified": "#ffd014",
      "text-git-added": "#32d74b",
      "text-git-removed": "#ff2c56",
      "text-git-modified": "#ffd014",
      "text-git-merged": "#b796ff",
      "text-git-closed": "#ff6159",
      "text-git-conflicting": "#fa832e",
      "text-git-draft": "#a6a6a6"
    }
  }
}

// A starfield like the page's, the same on every draw: a few stars twinkle, and
// a planet sits in the top right corner, away from the words and the prompt.
function starfield(): string {
  let seed = 11
  const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647
  const stars: string[] = []
  for (let i = 0; i < 260; i++) {
    const x = (random() * 1600).toFixed(1)
    const y = (random() * 1000).toFixed(1)
    const r = (0.5 + random() * random() * 1.6).toFixed(2)
    const opacity = (0.25 + random() * 0.55).toFixed(2)
    const twinkle = i % 9 === 0 ? ` class="t" style="animation-delay:-${(random() * 7).toFixed(1)}s"` : ''
    stars.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="#e8f1ff" opacity="${opacity}"${twinkle}/>`)
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">`
    + `<style>.t{animation:tw 7s ease-in-out infinite}@keyframes tw{0%,100%{opacity:.2}50%{opacity:1}}`
    + `@media (prefers-reduced-motion:reduce){.t{animation:none}}</style>`
    + `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#010205"/><stop offset="1" stop-color="#03070f"/></linearGradient>`
    + `<radialGradient id="haze1" cx="0.15" cy="0.8" r="0.45"><stop offset="0" stop-color="#3a2a6e" stop-opacity="0.12"/><stop offset="1" stop-color="#3a2a6e" stop-opacity="0"/></radialGradient>`
    + `<radialGradient id="haze2" cx="0.85" cy="0.2" r="0.4"><stop offset="0" stop-color="#1d6f86" stop-opacity="0.1"/><stop offset="1" stop-color="#1d6f86" stop-opacity="0"/></radialGradient>`
    + `<radialGradient id="planet" cx="0.34" cy="0.32" r="0.75"><stop offset="0" stop-color="#3f6280"/><stop offset="0.72" stop-color="#0d1b2c"/><stop offset="1" stop-color="#050b14"/></radialGradient></defs>`
    + `<rect width="1600" height="1000" fill="url(#sky)"/><rect width="1600" height="1000" fill="url(#haze1)"/><rect width="1600" height="1000" fill="url(#haze2)"/>`
    + stars.join('')
    + `<svg viewBox="0 0 400 300" preserveAspectRatio="xMaxYMin meet" width="100%" height="100%"><circle cx="330" cy="70" r="38" fill="url(#planet)"/></svg>`
    + `</svg>`
}

export const SPACE_LOOK: Look = {
  name: 'space',
  label: 'Space',
  es: 'Espacial',
  theme: { colors: SPACE_COLORS, backdrop: { scene: 'space', glass: { blur: 20, tint: "#07090e", opacity: 0.86 } } },
  scene: starfield(),
}
