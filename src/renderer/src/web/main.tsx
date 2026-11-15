import '../assets/main.css'

// Why a dynamic import and no top-level render: Rollup hoists modules shared by
// this entry's dynamic chunks into the entry chunk, and every other entry's
// chunks (cloud-admin included) would then statically import it and execute a
// second React root that replaces #root (U49). Keeping the mount in its own
// module leaves this chunk free of the shared app graph.
void import('./web-root').then((module) => module.mountWebRoot())

// Why: the web client is its own entry point and hosts terminals too, so it has
// to start the deferred WebGL addon load itself (see main.tsx). Dynamic because
// this entry deliberately keeps the whole App graph — pane manager included —
// out of its own startup chunk.
void import('../lib/pane-manager/pane-webgl-renderer').then((module) =>
  module.primeTerminalWebglAddon()
)
