import { z } from 'zod'
import { OptionalString } from './rpc-param-primitives'

/**
 * Managed creation (design §8.3): the caller names the root, because the host
 * cannot guess a path that must land inside a per-user workspace granted by a
 * cloud ticket. Nesting is forced off on the host, so the result is exactly
 * `<workspaceRoot>/<sanitized-name>`.
 *
 * Absolute paths are rejected here so the refusal names the field; the host
 * checks containment, which is what actually bounds the write.
 */
export const WorktreeManagedCreate = z.object({
  repo: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(z.string().min(1, 'Missing repo selector')),
  workspaceRoot: z
    .unknown()
    .transform((v) => (typeof v === 'string' ? v : ''))
    .pipe(
      z
        .string()
        .min(1, 'Missing workspace root')
        .refine(
          (value) => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value),
          'Workspace root must be absolute'
        )
    ),
  name: OptionalString,
  baseBranch: OptionalString,
  compareBaseRef: OptionalString,
  branchNameOverride: OptionalString,
  displayName: OptionalString,
  /** Retries with the same key return the first result instead of a second checkout. */
  idempotencyKey: OptionalString
})
