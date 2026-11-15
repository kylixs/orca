import '../assets/main.css'

// Why a dynamic import and no top-level render: Rollup hoists modules shared by
// this entry's dynamic chunks into the entry chunk, and other entries' chunks
// would then statically import it and mount a second React root (U49 mirror of
// the web entry). Keeping the render tree in its own module leaves this chunk
// side-effect-free for shared-chunk importers.
void import('./cloud-admin-root').then((module) => module.mountCloudAdmin())

// Why: the admin session page hosts terminals too, so it starts the deferred
// WebGL addon load itself (same reason as web/main.tsx). Dynamic because this
// entry keeps the pane-manager graph out of its own startup chunk.
void import('../lib/pane-manager/pane-webgl-renderer').then((module) =>
  module.primeTerminalWebglAddon()
)
