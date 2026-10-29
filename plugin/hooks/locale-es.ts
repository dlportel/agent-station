import type { Lang } from './station'

// The Spanish of everything the plugin says to people and agents, keyed by its
// English as written in the code. {name} placeholders take the values passed.
// A station whose config sets language "es" gets these; a text missing here is
// said in English.
const ES: Record<string, string> = {
  // the map each session gets
  '# Agent station{title}': '# Estación de agentes{title}',
  'This session belongs to the room "{room}" (folder `{folder}`). Each room is a repo with its own agent. When a task belongs to another room, you can ask its agent for it.':
    'Esta sesión es de la sala «{room}» (carpeta `{folder}`). Cada sala es un repo con su agente. Si una tarea corresponde a otra sala, puedes pedírsela a su agente.',
  '| Folder | Room | What it does |': '| Carpeta | Sala | Qué hace |',
  '(not described)': '(sin descripción)',
  "Never write to another room's sessions directly (with SendMessage or a session tool): work between rooms goes only through `{tool}`, so that the user approves it.":
    'No escribas nunca directamente a las sesiones de otra sala (con SendMessage o una herramienta de sesiones): el trabajo entre salas solo pasa por `{tool}`, para que el usuario lo apruebe.',
  ' (this session)': ' (esta sesión)',
  "Each repo of {groups} is also a room, with the repo's name as its folder.": 'Además, cada repo de {groups} es una sala, con el nombre del repo como carpeta.',
  "To ask another room for work, use the tool `{tool}` with `folder` (the folder in the table), `text` (what you need and why, with the context it needs) and `reason` (why you ask). How to do it, and with which subagent, is for the room that takes it to decide; use `agent` only when the user asks for a particular subagent. The order stays proposed and is not delivered until the user approves it in the station. Your own room's subagents you launch directly with the Agent tool, without an order.":
    'Para pedir trabajo a otra sala usa la herramienta `{tool}` con `folder` (la carpeta de la tabla), `text` (qué necesitas y por qué, con el contexto necesario) y `reason` (por qué lo pides). Cómo hacerlo, y con qué subagente, lo decide la sala que lo recibe; usa `agent` solo si el usuario te pide un subagente concreto. La orden queda propuesta y no se entrega hasta que el usuario la aprueba en la estación. Los subagentes de tu propia sala los lanzas directamente con la herramienta Agent, sin orden.',
  'The same tool returns the result of an order you received from another room: set `folder` to the room that asked, and the station delivers it to the session that sent it, without you naming it.':
    'La misma herramienta sirve para devolver el resultado de una orden que te llegó de otra sala: pon en `folder` la sala que la pidió y la estación se lo entrega a la sesión que te la envió, sin que tengas que indicarla.',
  'The coordination session (`{coordination}`) runs the station and delivers the approved orders, but it is no go-between for the rooms: never write to it to ask for work, return a result or forward anything; that is what `{tool}` is for.':
    'La sesión de coordinación (`{coordination}`) gestiona la estación y entrega las órdenes aprobadas, pero no hace de intermediaria entre salas: no le escribas para pedir trabajo, devolver un resultado ni reenviar nada; para eso está `{tool}`.',
  // the coordination's note beside a message from another session
  'This message comes from another session, not from the user.': 'Este mensaje viene de otra sesión, no del usuario.',
  'The coordination session runs the station and delivers the approved orders, but it is no go-between for the rooms. If the message asks you to forward something to another room, pass it a result or give it work, do not do it: answer the sender to use the tool `{tool}` with `folder` set to the room it is meant for. That tool leaves the order proposed in the station and, once the user approves it, delivers it to the right session, also when it answers an order received.':
    'La coordinación gestiona la estación y entrega las órdenes aprobadas, pero no hace de intermediaria entre salas. Si el mensaje te pide reenviar algo a otra sala, pasarle un resultado o encargarle trabajo, no lo hagas: contesta a quien lo envía que use la herramienta `{tool}` con `folder` igual a la sala de destino. Esa herramienta deja la orden propuesta en la estación y, cuando el usuario la aprueba, la entrega a la sesión que corresponde, también cuando es la respuesta a una orden recibida.',
  'The notices the user sends with {command} from another session are for you.': 'Los avisos que el usuario manda con {command} desde otra sesión sí son para ti.',
  // the orders delivered
  "Use this project's subagent `{agent}` to do it.": 'Usa el subagente `{agent}` de este proyecto para hacerlo.',
  'the station "{title}"': 'la estación «{title}»',
  'the station': 'la estación',
  'The coordination session only hands orders out: do not write to it or ask it to forward anything.': 'La sesión de coordinación solo reparte las órdenes: no le escribas ni le pidas que reenvíe nada.',
  'Order sent by the user from {station}:': 'Orden enviada por el usuario desde {station}:',
  'The Claude app replaces every at sign in this message with the full-width ＠ (U+FF20). In code, SQL, email addresses or paths, write the ordinary at sign (U+0040).': 'La app de Claude cambia todas las arrobas de este mensaje por la arroba de ancho completo ＠ (U+FF20). En código, SQL, direcciones de correo o rutas, escribe la arroba normal (U+0040).',
  'When you finish, tell the user the result in this same session.':'Cuando termines, cuéntale el resultado al usuario en esta misma sesión.',
  'its session "{title}"': 'su sesión «{title}»',
  'one of its sessions': 'una de sus sesiones',
  "return the result with the station's `propose_order` tool and `folder: \"{folder}\"`: the station delivers it to that same session once the user approves it, without you naming it.":
    'devuélvele el resultado con la herramienta `propose_order` de la estación y `folder: "{folder}"`: la estación se lo entrega a esa misma sesión cuando el usuario lo aprueba, sin que tengas que indicarla.',
  'It is addressed to this session because it answers an order this session sent to that room. If it is the result of what you asked for, do not answer it with another order: go on with your work and tell the user what is needed. If it asks you for something more, {answer}':
    'Va dirigida a esta sesión porque responde a una orden que esta sesión envió a esa sala. Si es el resultado de lo que pediste, no la contestes con otra orden: sigue con tu trabajo y cuéntale al usuario lo que haga falta. Si te pide algo más, {answer}',
  'When you finish, {answer}': 'Cuando termines, {answer}',
  'Order from the room "{room}" (folder `{folder}`), asked by {session} and sent from {station} with the user\'s approval:':
    'Orden de la sala «{room}» (carpeta `{folder}`), pedida por {session} y enviada desde {station} con la aprobación del usuario:',
  // the dispatcher's notes on orders
  'More than one session claims this order, so it is unclear which one is doing it. Give the order again and open its card as a new session.':
    'Más de una sesión reclama esta orden, así que no está claro cuál la está haciendo. Vuelve a dar la orden y abre su tarjeta como sesión nueva.',
  'Its card was run in a session of {other}, not in {room}, so nobody in {room} is doing it. Give the order again and open its card as a new session.':
    'Su tarjeta se ejecutó en una sesión de {other}, no en {room}, así que nadie de {room} la está haciendo. Vuelve a dar la orden y abre su tarjeta como sesión nueva.',
  'This message is the station order {order}, which is for the room {room}, not for this session (room {own}). Do not carry it out: tell the user that it belongs to {room}, and that its card has to be opened as a new session there.':
    'Este mensaje es la orden {order} de la estación, que es para la sala {room}, no para esta sesión (sala {own}). No la ejecutes: dile al usuario que es de {room} y que su tarjeta hay que abrirla allí como sesión nueva.',
  'The chosen session was no longer open: another one of the room takes it.': 'La sesión indicada ya no estaba abierta: la recibe otra de la sala.',
  'It could not be delivered: {error}': 'No se pudo entregar: {error}',
  'The chosen session is no longer open on {machine}.': 'La sesión indicada ya no está abierta en {machine}.',
  'No session of {room} is standing by on {machine}.': 'No hay ninguna sesión de {room} en espera en {machine}.',
  'that role': 'ese rol',
  'The model could not be switched to {model}: {error}': 'No se pudo cambiar el modelo a {model}: {error}',
  'Queued: the session was finishing something else.': 'En cola: la sesión estaba terminando otra cosa.',
  'A new session needs a role.': 'Una sesión nueva necesita un rol.',
  '{room} is not a room of this station on {machine}.': '{room} no es una sala de esta estación en {machine}.',
  'Station': 'Estación',
  'Order sent from the station for {room}. Click to open the session with this order as its first message.': 'Orden enviada desde la estación para {room}. Haz clic para abrir la sesión con esta orden como primer mensaje.',
  'Card ready in the coordination session of {machine}: click it to create the session.': 'Tarjeta lista en la sesión de coordinación de {machine}: haz clic en ella para crear la sesión.',
  'The new session could not be prepared: {error}': 'No se pudo preparar la sesión nueva: {error}',
  'Session created with your click.': 'Sesión creada con tu clic.',
  'Session created with your click and switched to {model}.': 'Sesión creada con tu clic y pasada a {model}.',
  'Session created, but the model could not be switched: {error}': 'Sesión creada, pero no se pudo cambiar el modelo: {error}',
  // the coordinator command
  'coordinator': 'coordinador',
  "Tell the station's coordination session about a problem with the system: the station, orders, the dispatcher or the mod itself":
    'Avisa a la sesión de coordinación de la estación de un problema del sistema: estación, órdenes, despachador o el propio mod',
  '[message]': '[mensaje]',
  'Write the notice after the command, for example: /{command} this session does not see propose_order': 'Escribe el aviso detrás del comando, por ejemplo: /{command} esta sesión no ve propose_order',
  'This session belongs to no station, so there is no coordination to tell.': 'Esta sesión no pertenece a ninguna estación, así que no hay coordinación a la que avisar.',
  'The station has no coordination repo (field coordination of config/departments).': 'La estación no tiene repo de coordinación (campo coordination de config/departments).',
  'No session of {room} is open on this computer. Open one and send the notice again.': 'No hay ninguna sesión de {room} abierta en este ordenador. Abre una y vuelve a lanzar el aviso.',
  'untitled session': 'sesión sin título',
  'no id': 'sin id',
  'Notice from the user for the coordination, sent from the session "{title}" ({room}, {id}) with /{command}:': 'Aviso del usuario para la coordinación, enviado desde la sesión «{title}» ({room}, {id}) con /{command}:',
  'Notice sent to the coordination ("{title}").': 'Aviso enviado a la coordinación («{title}»).',
  'The notice could not be sent: {error}': 'No se pudo enviar el aviso: {error}',
  // the status line
  'station: no connection ({error})': 'estación: sin conexión ({error})',
  // the permission prompts
  'This agent wants to write to another Claude Code session directly, outside the station. Work between rooms goes through propose_order, which waits for your approval in the station: allow this only if you asked for it.':
    'Este agente quiere escribir directamente a otra sesión de Claude Code, fuera de la estación. El trabajo entre salas pasa por propose_order, que espera tu aprobación en la estación: permítelo solo si se lo has pedido tú.',
  'The coordination session wants to republish the station page ({url}).': 'La sesión de coordinación quiere republicar la página de la estación ({url}).',
  'Allow it?': '¿Lo permites?',
  'Allow': 'Permitir',
  'Deny': 'Denegar',
  'Station': 'Estación',
  'The user did not allow it.': 'El usuario no lo ha permitido.',
  'The coordination session wants to delete the station page ({url}).': 'La sesión de coordinación quiere borrar la página de la estación ({url}).',
  'The coordination session wants to write to the station ({target}).': 'La sesión de coordinación quiere escribir en la estación ({target}).',
  '(data from the file {file})': '(datos del fichero {file})',
  'An agent wants to write to {url}, which cannot be checked for being a station.': 'Un agente quiere escribir en {url}, que no se puede comprobar si es una estación.',
  'an empty URL': 'una URL vacía',
  'An agent wants to write to {url} while a station does not answer, so it cannot be checked for being one of them.': 'Un agente quiere escribir en {url} mientras alguna estación no responde, así que no se puede comprobar si es una de ellas.',
  // handoffs, in the map and in the notes the dispatcher leaves for the page
  'each repo of `{group}`': 'cada repo de `{group}`',
  'The repos of this station are on hosts without handoffs: ask the rooms for work only with `{tool}`.':
    'Los repos de esta estación están en servidores sin encargos: pide trabajo a las salas solo con `{tool}`.',
  "Work that has to be followed up, or that may take a while, goes in a handoff: an issue in the repo of the room that has to do it. The station shows every open issue of a room's repo as its handoffs; add the labels your project uses to say who asks, if it has them. If it is urgent, also propose an order with `{tool}` that links the issue. To open it, use the command of that room's repo:":
    'El trabajo que hay que poder seguir, o que puede tardar, va en un encargo: una issue en el repo de la sala que tiene que hacerlo. La estación muestra como encargos todas las issues abiertas del repo de una sala; añade las etiquetas con las que tu proyecto dice quién lo pide, si las tiene. Si corre prisa, propón además con `{tool}` una orden que enlace la issue. Para abrirla, usa la orden del repo de esa sala:',
  '{rooms} are on hosts without handoffs: ask them for work only with `{tool}`.': '{rooms} están en servidores sin encargos: pídeles trabajo solo con `{tool}`.',
  'If the command fails because `gh` or `glab` is not installed or has no login, do not look for another way, and never write a token in a command, file, log or message: tell the user what is missing, and meanwhile ask for the work with `{tool}`, with all its context.':
    'Si la orden falla porque `gh` o `glab` no están instalados o no tienen login, no busques otra forma, y no escribas nunca un token en una orden, un fichero, un log ni un mensaje: dile al usuario qué falta y, mientras tanto, pide el trabajo con `{tool}`, con todo su contexto.',
  'Your room\'s handoffs are the open issues of its repo, `{repo}`: when the user speaks of handoffs, pending handoffs or the station\'s tasks, those issues are what they mean. To see them: `{list}`.':
    'Los encargos de tu sala son las issues abiertas de su repo, `{repo}`: cuando el usuario habla de encargos, encargos pendientes o tareas de la estación, se refiere a esas issues. Para verlas: `{list}`.',
  'A handoff is in progress when it has the label `in progress` or someone assigned to it; the others are waiting. Before you start one that no station order gave you, mark it in progress (`<n>` is its number): `{mark}`.':
    'Un encargo está en curso si tiene la etiqueta `in progress` o alguien asignado; los demás están esperando. Antes de empezar uno que no te haya llegado con una orden de la estación, márcalo en curso (`<n>` es su número): `{mark}`.',
  'Its repo is on {host}, which has no handoffs: only GitHub and GitLab do. Orders reach it as usual.':
    'Su repo está en {host}, que no tiene encargos: solo los tienen GitHub y GitLab. Las órdenes le llegan igual.',
  "`{tool}` is not installed on {machine}, so this room's handoffs are not read. Install it, log in and reload the coordination session.":
    '`{tool}` no está instalado en {machine}, así que los encargos de esta sala no se leen. Instálalo, haz login y recarga la sesión de coordinación.',
  '`{tool}` has no login for {host} on {machine}. Log in with `{login}`{token} and reload the coordination session.':
    '`{tool}` no tiene login para {host} en {machine}. Haz login con `{login}`{token} y recarga la sesión de coordinación.',
  ' (or set GITLAB_TOKEN)': ' (o define GITLAB_TOKEN)',
  // the branch an order's work starts from
  "A new session that an order opens may work in a git worktree of its repo (a folder under `.claude/worktrees`), on a branch of its own: the order's message says from which branch to start.":
    'Una sesión nueva que abre una orden puede trabajar en un worktree de git de su repo (una carpeta dentro de `.claude/worktrees`), en una rama propia: el mensaje de la orden dice desde qué rama empezar.',
  "Before you touch anything, start from the branch `{base}`{commit}. Check where this session is with `git branch --show-current` and `git rev-parse --short HEAD`. If it runs in a worktree of the repo (a folder under `.claude/worktrees`), it is on a branch of its own: if its commit is not the one the local `{base}` points at (`git rev-parse --short {base}`), create your work branch from the local `{base}`, not from `origin/{base}`, which may be behind: `git switch -c <your-branch> {base}`. If it runs in the repo's own folder and is not on `{base}`, do not switch branches there: ask the user first.":
    'Antes de tocar nada, parte de la rama `{base}`{commit}. Comprueba dónde está esta sesión con `git branch --show-current` y `git rev-parse --short HEAD`. Si trabaja en un worktree del repo (una carpeta dentro de `.claude/worktrees`), está en una rama propia: si su commit no es al que apunta la `{base}` local (`git rev-parse --short {base}`), crea tu rama de trabajo desde la `{base}` local, no desde `origin/{base}`, que puede ir por detrás: `git switch -c <tu-rama> {base}`. Si trabaja en la carpeta del propio repo y no está en `{base}`, no cambies de rama ahí: pregúntale antes al usuario.',
  ' (commit `{commit}`)': ' (commit `{commit}`)',
  "When the order was sent, the repo's own folder had changes that were not committed, and a worktree does not see them. If the work needs them, tell the user before you start.":
    'Cuando se envió la orden, la carpeta del propio repo tenía cambios sin commitear, y un worktree no los ve. Si el trabajo los necesita, díselo al usuario antes de empezar.',
  'This order starts from the branch `{base}`{commit}. This session runs in a worktree, on a branch of its own: if its commit is not the one the local `{base}` points at (`git rev-parse --short {base}`), create your work branch from the local `{base}` before you change anything: `git switch -c <your-branch> {base}`.':
    'Esta orden parte de la rama `{base}`{commit}. Esta sesión trabaja en un worktree, en una rama propia: si su commit no es al que apunta la `{base}` local (`git rev-parse --short {base}`), crea tu rama de trabajo desde la `{base}` local antes de cambiar nada: `git switch -c <tu-rama> {base}`.',
  'This session is on the branch `{branch}`, and this order was meant to start from `{base}`. Check with the user before you change anything.':
    'Esta sesión está en la rama `{branch}`, y esta orden debía partir de `{base}`. Confírmalo con el usuario antes de cambiar nada.',
  'Agent station: the list of open issues could not be saved ({error}). The boards keep the last list; it is tried again in fifteen minutes.':
    'Estación de agentes: no se pudo guardar la lista de issues abiertas ({error}). Los tableros mantienen la última lista; se vuelve a intentar dentro de quince minutos.',
  'Agent station · {rooms}: {problem}': 'Estación de agentes · {rooms}: {problem}',
  'Its handoffs could not be read ({error}). They are read again in fifteen minutes.': 'No se pudieron leer sus encargos ({error}). Se vuelven a leer dentro de quince minutos.',
  'There is no local branch `{base}` in this repo: use `origin/{base}` in its place, after `git fetch origin {base}`; if git does not find that either, ask the user.':
    'En este repo no hay una rama local `{base}`: usa `origin/{base}` en su lugar, después de `git fetch origin {base}`; si git tampoco la encuentra, pregunta al usuario.',
  // the keeper of the dispatcher
  'auto mode refuses its command': 'el modo auto rechaza su comando',
  'Agent station: KEEP AWAKE cannot start its command, because auto mode refuses it. Run this coordination session with permissions bypassed for it to work. It keeps trying every ten minutes.':
    'Estación de agentes: MANTENER DESPIERTO no puede lanzar su comando porque el modo auto lo rechaza. Para que funcione, pon esta sesión de coordinación en omitir permisos. Lo sigue intentando cada diez minutos.',
  'Agent station: KEEP AWAKE cannot start its command ({error}). It keeps trying every ten minutes.':
    'Estación de agentes: MANTENER DESPIERTO no puede lanzar su comando ({error}). Lo sigue intentando cada diez minutos.',
  'station: KEEP AWAKE does not start ({problem})': 'estación: MANTENER DESPIERTO no arranca ({problem})',
  'Agent station: this session reaches the station again.': 'Estación de agentes: esta sesión vuelve a conectar con la estación.',
  'Agent station: this session cannot reach the station ({error}), so the station does not show what it does. It keeps trying; the status line says so until it reconnects.':
    'Estación de agentes: esta sesión no puede conectar con la estación ({error}), así que la estación no muestra lo que hace. Lo sigue intentando; la barra de estado lo indica hasta que vuelva a conectar.',
  'Agent station: the order for {room} was not delivered: {note}': 'Estación de agentes: la orden para {room} no se pudo entregar: {note}',
  'no reason given': 'sin motivo',
  'Agent station: this coordination session runs in the {mode} permission mode. The station works fully only with permissions bypassed; in auto mode, KEEP AWAKE cannot start.':
    'Estación de agentes: esta sesión de coordinación está en el modo de permisos {mode}. La estación solo funciona del todo con omitir permisos; en modo auto, MANTENER DESPIERTO no puede arrancar.',
  'Keep the station dispatcher awake': 'Mantener despierto el despachador de la estación',
  // a session that cannot join its station yet
  'Agent station: this session could not join its station yet ({reason}). It keeps trying; if it does not join, run /reload-plugins.':
    'Estación de agentes: esta sesión aún no se ha podido unir a su estación ({reason}). Lo sigue intentando; si no lo consigue, ejecuta /reload-plugins.',
  'git could not read the remote of its repo': 'git no pudo leer el remote de su repo',
  'the station {url} could not be read: {error}': 'no se pudo leer la estación {url}: {error}',
  'no answer': 'no contesta',
  'it could not be checked': 'no se pudo comprobar',
}

// A text in the station's language, with its {placeholders} filled in.
export function tx(language: Lang | undefined, text: string, vars: Record<string, unknown> = {}): string {
  const template = language === 'es' && Object.hasOwn(ES, text) ? ES[text] : text
  return template.replace(/\{(\w+)\}/g, (match, key) => (Object.hasOwn(vars, key) ? String(vars[key]) : match))
}
