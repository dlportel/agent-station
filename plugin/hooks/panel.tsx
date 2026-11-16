import { atom, read, update } from 'claude-code'
import type { PanelOrder, ProposalCard } from '../types'
import type { Look } from './look'

// What the station draws in the app: the coordination session's orders pane
// and the band above its prompt, and under each propose_order call, what
// became of the order it proposed. A press in the pane is the user's own click,
// so it asks nothing more; what it writes is the page's own decision.
export const ORDERS_PANE = 'station-orders'
// Change the tag when a stored type's fields change: it declines what an
// earlier version stored, which outlives a reload.
const proposedOrders = atom({ plugin: 'agent-station', key: 'proposedOrders' } as const, [] as PanelOrder[], { shape: 'proposed-orders-2' })
const ordersNote = atom({ plugin: 'agent-station', key: 'ordersNote' } as const, '')
const proposalCards = atom({ plugin: 'agent-station', key: 'proposalCards' } as const, {} as Record<string, ProposalCard>, { shape: 'proposal-cards-1' })

// The drawings' values are written here, beside their atoms; a write redraws them.
export async function writePanelOrders($: any, orders: PanelOrder[]) {
  await update($, proposedOrders, () => orders)
}
export async function writeOrdersNote($: any, note: string) {
  await update($, ordersNote, () => note)
}
export async function readProposalCards($: any): Promise<Record<string, ProposalCard>> {
  return read($, proposalCards)
}
// Each change names its card by tool_use_id; null drops it.
export async function writeProposalCards($: any, changes: Record<string, ProposalCard | null>) {
  await update($, proposalCards, cards => {
    const next = { ...cards }
    for (const [id, card] of Object.entries(changes)) {
      if (card) next[id] = card
      else delete next[id]
    }
    return next
  })
}

type Say = (text: string, vars?: Record<string, unknown>) => string
export type StationUi = {
  say: Say
  isProposeTool: (tool: string) => boolean
  // Only in the coordination session: the pane's buttons and the band.
  decide?: (order: PanelOrder, isApprove: boolean) => Promise<void>
}

// The one line under a propose_order call: where its order stands.
export function proposalLine(card: ProposalCard, say: Say): string {
  const room = card.room
  if (card.status === 'proposed') return say('Order to {room}: waiting for your approval in the station.', { room })
  if (card.status === 'pending' || card.status === 'claimed') return say('Order to {room}: approved, being delivered.', { room })
  if (card.status === 'needs_click') return say('Order to {room}: approved, waiting for a session of the room to open.', { room })
  if (card.status === 'delivered' && card.isFinished) return say('Order to {room}: done; «{to}» finished the turn it started.', { room, to: card.to })
  if (card.status === 'delivered') return say('Order to {room}: delivered to «{to}».', { room, to: card.to })
  if (card.status === 'rejected') return say('Order to {room}: rejected.', { room })
  if (card.status === 'failed') return say('Order to {room}: it could not be delivered; the station says why.', { room })
  return say('Order to {room}: no longer in the station.', { room })
}

export function registerStationUi(on: any, ui: () => StationUi | undefined) {
  const sayOf = (current: StationUi | undefined): Say => current?.say ?? (text => text)
  const headlineOf = (say: Say, count: number) => count
    ? say(count === 1 ? '1 order waits for your approval.' : '{n} orders wait for your approval.', { n: count })
    : say('No order waits for your approval.')

  on('ui.render', { component: 'Pane', requestId: ORDERS_PANE }, async ($: any, e: any) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const current = ui()
    const say = sayOf(current)
    const decide = current?.decide
    const orders = await read($, proposedOrders)
    const note = await read($, ordersNote)
    const headline = headlineOf(say, orders.length)
    if (e.props?.placement === 'widget') return <Text>{headline}</Text>
    return (
      <Box flexDirection="column">
        <Text bold>{headline}</Text>
        {orders.map(order => (
          <Box key={order.id} flexDirection="column" marginTop={1}>
            <Text bold>{say('To {room}, asked by {asker}', { room: order.room, asker: order.asker })}</Text>
            {/* What the asker wrote goes in a frame of its own, apart from the header and the buttons. */}
            <Box flexDirection="column" borderStyle="single" paddingX={1}>
              <Text>{order.text}</Text>
              {order.reason ? <Text dimColor>{say('Reason:')} {order.reason}</Text> : null}
            </Box>
            {decide ? (
              <Box flexDirection="row">
                <Button key={`approve-${order.id}`} variant="primary" onPress={() => { void decide(order, true) }}>{say('Approve')}</Button>
                <Button key={`reject-${order.id}`} onPress={() => { void decide(order, false) }}>{say('Reject')}</Button>
              </Box>
            ) : null}
          </Box>
        ))}
        {note ? <Box marginTop={1}><Text dimColor>{note}</Text></Box> : null}
      </Box>
    )
  })

  // The coordination session's band says how many orders wait, even with the
  // pane closed, and opens the pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($: any, e: any, next: any) => {
    const current = ui()
    if (!current?.decide || e.props?.hasSurvey) return next(e)
    const orders = await read($, proposedOrders)
    if (!orders.length) return next(e)
    const say = sayOf(current)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row">
        <Text>{headlineOf(say, orders.length)} </Text>
        <Button key="open-orders" onPress={() => { void $.ui.open({ id: ORDERS_PANE, title: say('Station orders') }) }}>{say('Show')}</Button>
      </Box>
    )
  })

  // Under each propose_order call, where its order stands. Any other tool's
  // row is passed on before anything is read, so it never redraws for these.
  on('ui.render', { component: 'ToolUse' }, async ($: any, e: any, next: any) => {
    const current = ui()
    if (!current?.isProposeTool(String(e.props?.tool ?? ''))) return next(e)
    const card = (await read($, proposalCards))[String(e.props?.tool_use_id ?? '')]
    if (!card) return next(e)
    const row = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        {row}
        <Text dimColor>{proposalLine(card, current.say)}</Text>
      </Box>
    )
  })
}

// The scene of the station's look, drawn behind the conversation by the desktop
// and mobile apps; a backdrop another plugin set is left to it.
export function registerLookScenes(on: any, looks: Look[]) {
  on('ui.render', { component: 'Backdrop' }, ($: any, e: any, next: any) => {
    if (e.props?.plugin && e.props.plugin !== $.plugin.name) return next(e)
    const look = looks.find(l => l.name === e.props?.scene && l.scene)
    if (!look?.scene) return next(e)
    const { Svg } = $.ui.resolve(e)
    return <Svg source={look.scene} alt={look.label} />
  })
}
