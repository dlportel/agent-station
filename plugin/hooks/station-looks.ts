import type { Look } from './look'

// A station's own looks for the app, offered by /station-look beside the
// engine's space look. This file belongs to each station's copy of the plugin:
// the engine's sync writes it only where it is missing, so the looks a station
// lists here are kept. A look with the name of the station's page theme goes
// with that theme; see look.ts for how a look is made. A look named like the
// engine's (space) is left out: the engine's keeps its name.
export const STATION_LOOKS: Look[] = []
