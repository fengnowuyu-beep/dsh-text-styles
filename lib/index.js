/**
 * dsh-text-styles 鈥?host half.
 *
 * Owns exactly one thing: the persisted style document (which preset, and which
 * option overrides, each text target uses) and the same-origin route family the
 * browser half posts to. It knows nothing about translation, so this plugin can be
 * installed, updated or removed on its own.
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

function dshHome(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/**
 * @param configured - optional `dshHome` from the plugin's own config.
/** Route family mounted on the Host webserver. */
export const ROUTE_PREFIX = '/text-styles/api'

/** Cordis services required before the routes can mount. */
export const inject = ['webServer']

/** @type {readonly string[]} */
const ROUTE_KEYS = ['settings.get', 'settings.update']

/** Plugin version marker surfaced to the settings page for support. */
const PLUGIN_VERSION = '1.0.0'

/** The document a fresh install starts with: module off, preview live. */
const DEFAULT_TEXT_STYLE = Object.freeze({ enabled: false, live: true, targets: {} })

/**
 * @param configured - optional `dshHome` from the plugin's own config.
 * @returns the absolute path of this plugin's settings document.
 */
function settingsPath(configured) {
  return join(dshHome(configured), 'text-styles', 'settings.json')
}

/**
 * Where the style document lived before the plugins were split apart.
 *
 * It was one field of the combined plugin's settings. The split reads it once, so a
 * carefully tuned set of presets survives the move instead of silently resetting.
 *
 * @param configured - optional `dshHome` from the plugin's own config.
 * @returns the absolute path of the legacy settings document.
 */
function legacySettingsPath(configured) {
  return join(dshHome(configured), 'text-manager', 'settings.json')
}


function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

const MAX_STYLE_BYTES = 24_000

/**
 * Keep the style module's document to a shape the browser half can trust: one
 * flag pair plus per-target `{ preset, options }` where every option is a short
 * primitive. The catalogue itself lives in the browser half, so unknown targets
 * are preserved rather than rejected — a newer client may know more than this
 * host does.
 * @param raw - the value from the settings document.
 * @returns a safe, size-bounded document.
 */
function normalizeTextStyle(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const targets = {}
  const entries = source.targets !== null && typeof source.targets === 'object' ? Object.entries(source.targets) : []
  for (const [key, value] of entries.slice(0, 64)) {
    if (typeof key !== 'string' || key === '' || key.length > 40) continue
    if (value === null || typeof value !== 'object') continue
    const options = {}
    for (const [option, setting] of Object.entries(value.options ?? {}).slice(0, 32)) {
      if (option.length > 24) continue
      if (typeof setting === 'boolean') options[option] = setting
      else if (typeof setting === 'number' && Number.isFinite(setting)) options[option] = setting
      else if (typeof setting === 'string' && setting.length <= 64) options[option] = setting
    }
    targets[key] = { preset: typeof value.preset === 'string' ? value.preset.slice(0, 32) : 'default', options }
  }
  const styles = {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_SETTINGS.textStyle.enabled,
    live: typeof source.live === 'boolean' ? source.live : DEFAULT_SETTINGS.textStyle.live,
    targets
  }
  return JSON.stringify(styles).length > MAX_STYLE_BYTES ? { ...DEFAULT_SETTINGS.textStyle } : styles
}

/** Coerce a user value into the settings contract. */
function isTrusted(request) {
  if (typeof request?.socket?.remoteAddress === 'string'
    && !isLoopbackAddress(request.socket.remoteAddress)) return false
  const host = request?.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

/** IPv4 127/8 predicate. */
function isIPv4Loopback(address) {
  const parts = address.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether a socket remote address is loopback (IPv4, IPv6, or IPv4-mapped). */
function isLoopbackAddress(address) {
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7))
  return isIPv4Loopback(normalized)
}

/** Whether a URL hostname names loopback. */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/** Read a JSON body with a hard size cap. */
async function readJsonBody(request, limit = 1_000_000) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'payload-too-large', 'request body is too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'bad-json', 'request body is not valid JSON')
  }
}

/** One route-level failure carrying its HTTP status. */
class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Write one JSON response. */
function writeJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  })
  response.end(body)
}

/**
 * Durable segment store, one entry per translated segment.
 *
 * The key is the source text alone, deliberately: a translation is a property
 * of the text, so re-opening a conversation — or restarting the harness — hands
 * back the exact text that was produced the first time instead of paying for it
 * again (and instead of getting a subtly different translation). Only an
 * explicit refresh bypasses it.
 */


/**
 * Read the style document, adopting it out of the combined plugin's settings the
 * first time this plugin runs.
 *
 * @param logger - the plugin logger.
 * @param configuredHome - optional `dshHome`.
 * @returns the normalized document.
 */
function loadSettings(logger, configuredHome) {
  const file = settingsPath(configuredHome)
  try {
    if (existsSync(file)) return normalizeTextStyle(JSON.parse(readFileSync(file, 'utf8')))
    const legacy = legacySettingsPath(configuredHome)
    if (existsSync(legacy)) {
      const raw = JSON.parse(readFileSync(legacy, 'utf8'))
      if (raw?.textStyle !== undefined) {
        logger?.info?.('text-styles: adopting the style document left by text-manager')
        return normalizeTextStyle(raw.textStyle)
      }
    }
  } catch (error) {
    logger?.warn?.(`text-styles: settings unreadable, using defaults: ${String(error)}`)
  }
  return normalizeTextStyle(DEFAULT_TEXT_STYLE)
}

/** Atomically persist the style document. */
async function saveSettings(next, configuredHome) {
  const file = settingsPath(configuredHome)
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
}

/** @returns the projection the browser half reads. */
function publicSettings(settings, configuredHome) {
  return {
    pluginVersion: PLUGIN_VERSION,
    settingsFile: settingsPath(configuredHome),
    enabled: settings.enabled,
    live: settings.live,
    targets: settings.targets
  }
}

/**
 * Mount the settings routes.
 *
 * @param ctx - the Cordis host context (provides `webServer`).
 * @param config - optional plugin config (`dshHome` overrides the harness home).
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return

  const logger = ctx.logger ?? console
  const configuredHome = config?.dshHome
  let settings = loadSettings(logger, configuredHome)

  /** Dispatch one route method. */
  const dispatch = async (method, payload) => {
    switch (method) {
      case 'settings.get':
        return { settings: publicSettings(settings, configuredHome) }
      case 'settings.update': {
        settings = normalizeTextStyle(payload?.settings ?? payload)
        await saveSettings(settings, configuredHome)
        return { settings: publicSettings(settings, configuredHome) }
      }
      default:
        throw new HttpError(404, 'not-found', `unknown method "${String(method)}"`)
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (request, response) => {
      if (!isTrusted(request)) {
        writeJson(response, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (request.method !== 'POST') {
        writeJson(response, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith(`${ROUTE_PREFIX}/`)
        ? pathname.slice(ROUTE_PREFIX.length + 1)
        : undefined
      if (method === undefined || !ROUTE_KEYS.includes(method)) {
        writeJson(response, 404, { ok: false, error: { code: 'not-found', message: `unknown method "${String(method)}"` } })
        return
      }
      try {
        const payload = await readJsonBody(request)
        const data = await dispatch(method, payload)
        if (!response.writableEnded) writeJson(response, 200, { ok: true, ...data })
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500
        const code = error instanceof HttpError ? error.code : 'internal-error'
        const message = error instanceof Error ? error.message : String(error)
        if (status >= 500) logger.warn?.(`text-styles: ${method} failed: ${message}`)
        if (!response.writableEnded) writeJson(response, status, { ok: false, error: { code, message } })
      }
    }
  }), 'text-styles: routes')

  logger.info?.(`text-styles: mounted ${ROUTE_PREFIX} (settings: ${settingsPath(configuredHome)})`)
}
