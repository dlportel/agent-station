// The values the plugin keeps for a session in the host's state ($.state):
// they survive a reload of the plugin and end with the session's process.

// The background tasks that keep the dispatcher's session awake.
export type KeeperTaskIds = string[]

declare module 'claude-code' {
  interface PluginState {
    'agent-station': { keeperTaskIds: KeeperTaskIds }
  }
}
