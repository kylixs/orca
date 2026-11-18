import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after } from 'node:test'

/**
 * U275: the copied one-liner is a shell program, so its contract can only be
 * proven by running it. Both the source-derived runtime suite and the wizard
 * suite share this harness so the command under test is extracted once, never
 * re-typed as a second implementation.
 */

const APP_SOURCE = fileURLToPath(new URL('../../../apps/web/app.js', import.meta.url))

export type InstallCommandTemplate = {
  /** installCommand's body, for source-shape assertions. */
  source: string
  /** The temp-file expression installCommand binds. */
  file: string
  /** The returned template literal, still carrying `${file}` / `${url}`. */
  template: string
}

/**
 * Extracts `installCommand` from app.js and fails fast unless its template only
 * interpolates `${file}` / `${url}` and escapes only `\${code}`. Anything else
 * (``${url:-x}``, `${VAR}`, `${encodeURI(url)}`) would reach bash with shell
 * semantics instead of the JS value this harness renders.
 */
export function installCommandTemplateSource(): InstallCommandTemplate {
  const app = readFileSync(APP_SOURCE, 'utf8')
  const fn = /function installCommand\(url\) \{\n([\s\S]*?)\n\}/.exec(app)
  assert.ok(fn, 'app.js must define installCommand(url)')
  const source = fn[1]
  const file = /const file = '([^']+)'/.exec(source)?.[1]
  assert.ok(file, 'installCommand must bind the temp file path')
  const template = /return `([\s\S]*?)`/.exec(source)?.[1]
  assert.ok(template, 'installCommand must return a template literal')

  assertInstallTemplateInterpolations(template)
  // The renderer decodes only `\${code}`; any other escape would diverge from
  // real JS template evaluation, so fail here rather than run a wrong program.
  assert.doesNotMatch(
    template,
    /\\(?!\$\{code\})/,
    'installCommand template has a backslash escape this harness does not model'
  )
  assert.ok(template.includes('\\${code}'), 'the exit-code message must escape ${code}')
  return { source, file, template }
}

/**
 * Fails unless the template interpolates exactly `${file}` and `${url}`. Both are
 * required: a hardcoded path or URL would still render, so the suite must see
 * the source actually interpolate each value it claims to exercise.
 */
export function assertInstallTemplateInterpolations(template: string): void {
  // `[^}]*` (not `\w+`) so non-identifier forms are seen and rejected, not skipped.
  const interpolations = [
    ...new Set([...template.matchAll(/(?<!\\)\$\{([^}]*)\}/g)].map((m) => m[0]))
  ]
  const unexpected = interpolations.filter((token) => token !== '${file}' && token !== '${url}')
  assert.deepEqual(
    unexpected,
    [],
    `installCommand may only interpolate \${file} and \${url}; found: ${unexpected.join(', ')}`
  )
  const missing = ['${file}', '${url}'].filter((token) => !interpolations.includes(token))
  assert.deepEqual(
    missing,
    [],
    `installCommand must interpolate both \${file} and \${url}; missing: ${missing.join(', ')}`
  )
}

/** Renders the extracted template the way JS would, for the given URL. */
export function renderInstallCommand(template: string, file: string, url: string): string {
  // Single pass: inserted values are never rescanned for the other placeholder.
  return template.replace(/\\(\$\{code\})|\$\{url\}|\$\{file\}/g, (match, code) =>
    code ? '${code}' : match === '${url}' ? url : file
  )
}

/** A failed download: curl never creates the file, or dies mid-body. */
export type DownloadFailure = 'unreachable' | 'partial'

export type OneLinerRun = {
  status: number | null
  stdout: string
  stderr: string
  /** Scratch HOME; also the shell's cwd. */
  home: string
  tmpDir: string
  /** Everything left in TMPDIR after the run. */
  kept: string[]
}

export type OneLinerRunOptions = {
  /** Install-script body the stub curl writes; null makes the download fail. */
  body: string | null
  /** Only meaningful when `body` is null. */
  failure?: DownloadFailure
  /** Extra stub executables placed ahead of the system PATH. */
  extraStubs?: Record<string, string>
  scratchPrefix?: string
}

const scratchDirs: string[] = []

after(() => {
  for (const dir of scratchDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const CURL_OUT_ARGS = `prev=""
out=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  prev="$arg"
done
[ -n "$out" ] || exit 2
`

/**
 * Runs `command` with a stub curl. `body === null` makes the download fail:
 * `unreachable` exits 22 without creating the `-o` target, `partial` writes
 * bytes then exits 18 like a transfer cut mid-body (U276). Otherwise the stub
 * writes `body` to the `-o` target and exits 0, so the only exit code left is
 * the install script's own. Each scratch HOME/TMPDIR is removed at file end.
 */
export function runOneLiner(command: string, options: OneLinerRunOptions): OneLinerRun {
  const {
    body,
    failure = 'unreachable',
    extraStubs = {},
    scratchPrefix = 'orca-one-liner-'
  } = options
  const home = mkdtempSync(join(tmpdir(), scratchPrefix))
  scratchDirs.push(home)
  const bin = join(home, 'bin')
  mkdirSync(bin)
  const curl =
    body === null
      ? failure === 'partial'
        ? `#!/usr/bin/env bash
${CURL_OUT_ARGS}cat > "$out" <<'ORCA_U276_PARTIAL'
#!/usr/bin/env bash
echo 'U276-PARTIAL-DOWNLOAD'
ORCA_U276_PARTIAL
: > "$HOME/u276-partial-written"
exit 18
`
        : '#!/usr/bin/env bash\nexit 22\n'
      : `#!/usr/bin/env bash
${CURL_OUT_ARGS}cat > "$out" <<'ORCA_ONE_LINER_STUB'
${body}
ORCA_ONE_LINER_STUB
exit 0
`
  writeFileSync(join(bin, 'curl'), curl, { mode: 0o755 })
  for (const [name, script] of Object.entries(extraStubs)) {
    writeFileSync(join(bin, name), script, { mode: 0o755 })
  }
  const tmpDir = join(home, 'tmp')
  mkdirSync(tmpDir)
  const result = spawnSync('bash', ['-c', command], {
    encoding: 'utf8',
    cwd: home,
    timeout: 10_000,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: tmpDir }
  })
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    home,
    tmpDir,
    kept: readdirSync(tmpDir)
  }
}
