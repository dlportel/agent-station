// The values the plugin keeps for a session in the host's state ($.state):
// they survive a reload of the plugin and end with the session's process.

// The background tasks that keep the dispatcher's session awake.
export type KeeperTaskIds = string[]

// The dispatcher of the plugin's latest copy in the session: an older copy's
// dispatcher that finds another generation here stops.
export type DispatcherGeneration = string

// A proposed order as the coordination session's orders pane shows it: the
// version read goes with the decision, so a change made meanwhile is kept.
export type PanelOrder = { id: string; version: number; room: string; asker: string; reason: string; text: string }

// What became of an order this session proposed, drawn under the propose_order
// call that made it, keyed by that call's tool_use_id. status is the order's,
// or 'gone' once it is no longer in the station; to is the session it went to.
export type ProposalCard = { orderId: string; room: string; status: string; to: string; isFinished: boolean; proposedAt: number }

declare module 'claude-code' {
  interface PluginState {
    'agent-station': {
      keeperTaskIds: KeeperTaskIds
      dispatcherGeneration: DispatcherGeneration
      proposedOrders: Shaped<PanelOrder[]>
      // The outcome of the pane's last approval or rejection, shown under it.
      ordersNote: string
      proposalCards: Shaped<Record<string, ProposalCard>>
    }
  }
}
