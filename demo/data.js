// The demo's stand-in for the station's database: the example template
// (examples/seed.json) as the configuration, a few made-up sessions in its
// rooms, and some orders. An order you give, or a proposal you approve, is
// marked delivered a moment later, as the coordination session would do; no
// agent receives it. It all lives in the browser tab and is gone on reload.
// Add ?lang=es to the address to see the station in Spanish.
(() => {
  const now = Date.now();
  const session = (id, folder, state, model, extra) => ({ id, data: () => ({ folder, title: id, state, model, lastEventAt: now - 20000, startedAt: now - 3600000, machine: "LAPTOP", modVersion: "1.1.3", drones: [], ...extra }) });
  const sessions = [
    session("web-1", "web", "working", "claude-opus-5-5", { title: "Pricing page redesign", tool: "Edit", detail: "pricing.astro" }),
    session("web-2", "web", "waiting", "claude-sonnet-5-5", { title: "Blog images", waitKind: "permission", tool: "Bash", detail: "npm" }),
    session("mob-1", "mobile", "working", "claude-opus-5-5", { title: "Offline sync", tool: "Read", detail: "sync_service.dart", drones: ["code-reviewer"] }),
    session("mob-2", "mobile", "standby", "claude-sonnet-5-5", { title: "Release notes" }),
    session("api-1", "api", "working", "claude-fable-5-1", { title: "Rate limits", tool: "Bash", detail: "pytest" }),
    session("api-2", "api", "standby", "claude-opus-5-5", { title: "Auth tokens" }),
    session("api-3", "api", "working", "claude-haiku-5-5", { title: "OpenAPI schema", tool: "Grep", detail: "operationId" }),
    session("docs-1", "docs", "working", "claude-sonnet-5-5", { title: "Getting started guide", tool: "WebFetch", detail: "developer.mozilla.org" }),
    session("docs-2", "docs", "waiting", "claude-opus-5-5", { title: "API reference", waitKind: "question" }),
    session("coord-1", "station", "idle", "claude-opus-5-5", { title: "Coordination" }),
    session("mob-asker", "mobile", "idle", "claude-opus-5-5", { title: "Offline sync" }),
  ];
  // Each order is { id, data() } over a record that changes in place.
  const order = (id, record) => ({ id, record, data: () => record });
  const proposal = { text: "The mobile app needs a delta endpoint for offline sync: GET /v2/changes?since=<cursor>, returning the records changed since the cursor and the next cursor. Add it with tests and document it in the OpenAPI schema.", folder: "api", mode: "any", status: "proposed", createdAt: now - 120000, reason: "Offline sync in the app cannot ship without it", proposedBy: { sessionId: "mob-asker", title: "Offline sync", folder: "mobile" } };
  const orders = [
    order("p_demo", proposal),
    order("o1", { text: "Update the changelog for 2.4", folder: "docs", mode: "any", status: "delivered", createdAt: now - 3600000, deliveredAt: now - 3500000, deliveredTo: "docs-1", deliveredTitle: "Getting started guide" }),
    order("o2", { text: "Review the pricing copy", folder: "web", mode: "any", status: "delivered", createdAt: now - 1800000, deliveredAt: now - 1700000, deliveredTo: "web-1", deliveredTitle: "Pricing page redesign", model: "claude-opus-5-5" }),
  ];
  const dispatchers = [{ id: "LAPTOP", data: () => ({ sessionId: "coord-1", machine: "LAPTOP", heartbeatAt: now }) }];
  const snapCol = docs => ({ docs });
  const snapDoc = d => ({ exists: !!d, data: () => d, metadata: { fromCache: false } });
  const language = new URLSearchParams(location.search).get("lang") === "es" ? "es" : "en";
  let departments = null;
  const configListeners = [], orderListeners = [];
  const notifyOrders = () => orderListeners.forEach(cb => cb(snapCol([...orders])));
  // What the coordination session does with an order: hand it to an open
  // session of its room, or leave a card for a new one.
  const deliverLater = o => setTimeout(() => {
    const target = sessions.map(s => ({ id: s.id, ...s.data() })).find(s => s.folder === o.record.folder && s.state !== "ended");
    Object.assign(o.record, o.record.mode !== "new" && target
      ? { status: "delivered", deliveredTo: target.id, deliveredTitle: target.title, deliveredAt: Date.now() }
      : { status: "needs_click", note: "In a real station, a card to open the new session waits in the coordination session." });
    notifyOrders();
  }, 2500);
  window.claude = { use: async name => name !== "db" ? null : ({
    collection: name => ({
      add: async data => {
        const o = order(`o_${Date.now().toString(36)}`, { ...data });
        orders.unshift(o);
        notifyOrders();
        if (o.record.status === "pending") deliverLater(o);
        return { id: o.id };
      },
      onSnapshot: cb => {
      setTimeout(() => {
        if (name === "orders") orderListeners.push(cb);
        cb(snapCol(name === "sessions" ? sessions : name === "orders" ? orders : name === "dispatchers" ? dispatchers : []));
      }, 0);
      return () => {};
    } }),
    doc: path => ({
      onSnapshot: cb => { (async () => {
        if (path !== "config/departments") return cb(snapDoc(null));
        if (!departments) departments = { ...(await (await fetch("../examples/seed.json")).json()), language };
        configListeners.push(cb);
        cb(snapDoc(departments));
      })(); return () => {}; },
      update: async patch => {
        const o = orders.find(x => `orders/${x.id}` === path);
        if (!o) return;
        const wasPending = o.record.status === "pending";
        Object.assign(o.record, patch);
        notifyOrders();
        if (!wasPending && o.record.status === "pending") deliverLater(o);
      },
      set: async doc => { if (path === "config/departments") { departments = JSON.parse(JSON.stringify(doc)); configListeners.forEach(cb => cb(snapDoc(departments))); } },
    }),
  }) };
})();
