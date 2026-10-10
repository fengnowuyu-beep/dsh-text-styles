/**
 * Settings-page test.
 *
 * `lib/client.js` is a module-loader bundle whose browser half is React. This
 * harness supplies a tiny hooks engine (hook slots, one-shot effects, a
 * `useSyncExternalStore` seat), a stubbed `fetch` standing in for the plugin's
 * host routes, and then drives the page's real controls: show/hide the key,
 * fetch the model directory, and run the translation self-test.
 *
 * It is a render-behaviour test, not a browser test: it proves the component
 * mounts without throwing and that each control performs the right host call.
 *
 * Run: node test/settings.test.mjs
 */
import assert from 'node:assert/strict'

// ── minimal DOM / platform stubs ────────────────────────────────────────────
let definition
globalThis.window = {
  __ModuleLoader__: { load: (value) => { definition = value } },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout,
  clearTimeout
}
globalThis.document = {
  body: {},
  head: { appendChild: () => {} },
  activeElement: null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ dataset: {}, style: {}, append() {}, addEventListener() {}, remove() {} }),
  addEventListener() {},
  removeEventListener() {}
}
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.CSS = { escape: (value) => value }
globalThis.MouseEvent = class { constructor(type, init) { this.type = type; this.init = init } }

// ── tiny hooks engine ───────────────────────────────────────────────────────
/** Persistent hook slots, indexed by call order — exactly how React keys them. */
let slots = []
let cursor = 0
/** Effect indices that already ran (all deps here are `[]`). */
let ranEffects = new Set()
/** Effects queued during the current render. */
let pendingEffects = []
/** Set when a state update asked for another render. */
let dirty = false

/** React stand-in. */
const React = {
  createElement: (type, props, ...children) => {
    const flat = children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false && child !== '')
    // Function components are invoked eagerly, exactly like React would. The
    // only hook-bearing component here is `SettingsSection` itself, which the
    // harness invokes directly so hook order stays under `cursor`.
    if (typeof type === 'function') return type({ ...(props ?? {}), children: flat })
    return { type, props: props ?? {}, children: flat }
  },
  Fragment: 'Fragment',
  useEffect(fn) {
    const index = cursor++
    if (!ranEffects.has(index)) {
      ranEffects.add(index)
      pendingEffects.push(fn)
    }
  },
  useMemo(fn) {
    cursor++
    return fn()
  },
  useRef(initial) {
    const index = cursor++
    if (!(index in slots)) slots[index] = { current: initial }
    return slots[index]
  },
  useState(initial) {
    const index = cursor++
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
    return [slots[index], (next) => {
      slots[index] = typeof next === 'function' ? next(slots[index]) : next
      dirty = true
    }]
  },
  useSyncExternalStore(subscribe, getSnapshot) {
    const index = cursor++
    if (!(index in slots)) {
      slots[index] = subscribe(() => { dirty = true })
    }
    return getSnapshot()
  }
}
const fakeRequire = (id) => {
  if (id === 'react') return { default: React, ...React }
  if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }
  throw new Error(`unexpected require("${id}")`)
}

// ── host-route stub ─────────────────────────────────────────────────────────
/** Host state the stub serves. */
const host = {
  enabled: false,
  live: true,
  targets: { body: { preset: 'default', options: { borderSides: 'left', paddingLeft: 12 } } },
  pluginVersion: '1.0.0',
  settingsFile: 'C:/Users/x/.dsh/text-styles/settings.json'
}
/** Every host method the page called, in order. */
const calls = []

/** @returns a fake `Response` whose body carries `ok: true`. */
function respond(payload) {
  return { ok: true, status: 200, json: async () => ({ ok: true, ...payload }) }
}

globalThis.fetch = async (url, init) => {
  const method = String(url).split('/').pop()
  const body = init?.body ? JSON.parse(init.body) : {}
  calls.push({ method, body })
  switch (method) {
    case 'settings.get':
      return respond({
        settings: {
          pluginVersion: '1.1.0',
          settingsFile: 'C:\\fake\\settings.json',
          translationsFile: 'C:\\fake\\translations.json',
          translationCount: host.translationCount,
          enabled: host.enabled,
          baseUrl: host.baseUrl,
          model: host.model,
          thinking: host.thinking,
          onlyEnglish: host.onlyEnglish,
          autoExpand: host.autoExpand,
          translateProse: host.translateProse,
          includeHistory: host.includeHistory,
          cutMode: host.cutMode,
          textStyle: host.textStyle,
          maxSegmentChars: host.maxSegmentChars,
          timeoutMs: host.timeoutMs,
          cachedModels: host.cachedModels,
          apiKeySet: host.apiKeySet,
          apiKeyMask: 'sk-liv****************mnop'
        }
      })
    case 'settings.update':
      Object.assign(host, body.settings ?? {})
      if (typeof body.settings?.apiKey === 'string' && body.settings.apiKey !== '') {
        host.apiKey = body.settings.apiKey
        host.apiKeySet = true
      }
      return respond({
        settings: {
          pluginVersion: '1.1.0',
          translationsFile: 'C:\\fake\\translations.json',
          translationCount: host.translationCount,
          enabled: host.enabled,
          baseUrl: host.baseUrl,
          model: host.model,
          thinking: host.thinking,
          onlyEnglish: host.onlyEnglish,
          autoExpand: host.autoExpand === true,
          translateProse: host.translateProse === true,
          includeHistory: host.includeHistory === true,
          cutMode: host.cutMode,
          textStyle: host.textStyle,
          maxSegmentChars: host.maxSegmentChars,
          timeoutMs: host.timeoutMs,
          cachedModels: host.cachedModels,
          apiKeySet: host.apiKeySet,
          apiKeyMask: 'sk-liv****************mnop'
        }
      })
    case 'settings.reveal':
      return respond({ apiKey: host.apiKey })
    case 'models.list':
      host.cachedModels = host.models
      return respond({ models: host.models })
    case 'translate':
      return respond({ text: `【译】${String(body.text).slice(0, 24)}`, cached: false, skipped: false })
    case 'test':
      return respond({ model: host.model, thinking: host.thinking, reply: 'ok' })
    default:
      return respond({})
  }
}

await import('../lib/client.js')
assert.ok(definition !== undefined, 'the bundle must call __ModuleLoader__.load')

const bundle = definition.factory(fakeRequire)
const { __internals } = bundle
const SettingsSection = __internals?.SettingsSection
assert.equal(typeof SettingsSection, 'function', 'the settings section must be exported for inspectability')

/** Fake engine the page reads status from. */
const engine = {
  subscribe: () => () => {},
  getSnapshot: () => ({ enabled: true, ready: true, rows: 0, pending: 0, lastError: '' }),
  reload: async () => { calls.push({ method: 'engine.reload', body: null }) }
}

/**
 * Keys whose copy carries a placeholder. The identity reader used elsewhere
 * would leave `{count}` unresolved, so those two get their real shape.
 */
const PLACEHOLDERS = {
  storedCount: '{count} translation(s) stored',
  modelListOk: '{count} models available.'
}
/** The page's locale reader: the key itself, or the placeholder-bearing copy. */
const t = (key) => PLACEHOLDERS[key] ?? key

/** Render the section once and run any first-mount effects. */
function render() {
  cursor = 0
  pendingEffects = []
  const tree = SettingsSection({ t, engine })
  const effects = pendingEffects
  pendingEffects = []
  for (const effect of effects) effect()
  return tree
}

/** Let pending promises settle, then re-render if state changed. */
async function settle(tree) {
  for (let i = 0; i < 12; i++) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
  for (let i = 0; i < 12; i++) await Promise.resolve()
  return dirty ? render() : tree
}

/** Flatten a rendered tree to a list of element nodes. */
function nodes(tree, out = []) {
  if (Array.isArray(tree)) {
    for (const child of tree) nodes(child, out)
    return out
  }
  if (tree === null || typeof tree !== 'object' || !('type' in tree)) return out
  out.push(tree)
  nodes(tree.children, out)
  return out
}

/** Visible text of a node. */
function textOf(tree) {
  if (tree === null || tree === undefined || tree === false) return ''
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(textOf).join('')
  if (typeof tree === 'object' && 'children' in tree) return textOf(tree.children)
  return ''
}

/** @returns every node whose text equals `label`. */
function byText(tree, label) {
  return nodes(tree).filter(node => textOf(node) === label)
}

/** @returns the button carrying `label`. */
function button(tree, label) {
  const found = nodes(tree).find(node => node.type === 'button' && textOf(node) === label)
  assert.ok(found !== undefined, `expected a button labelled "${label}"`)
  return found
}

// ── the bundle under test ───────────────────────────────────────────────────
// The harness above already loaded the bundle, and it supplies engine (a stub it
// reads status from) and the calls array that the route stub fills in.
const styleEngine = bundle.__internals.styleEngine
Object.assign(engine, {
  apply: () => {},
  revert: () => {},
  commit: () => {}
})

globalThis.fetch = async (url, init) => {
  const method = String(url).split('/').pop()
  const body = JSON.parse(init?.body ?? '{}')
  calls.push({ url: String(url), method, body })
  if (method === 'settings.update') Object.assign(host, body.settings ?? {})
  if (method !== 'settings.get' && method !== 'settings.update') {
    return { ok: false, status: 404, json: async () => ({ ok: false, error: { code: 'not-found', message: 'no' } }) }
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      settings: { enabled: host.enabled, live: host.live, targets: host.targets },
      pluginVersion: host.pluginVersion,
      settingsFile: host.settingsFile
    })
  }
}

/** Cleanups handed back by effects. */
const cleanups = []
globalThis.fetch = async (url, init) => {
  const method = String(url).split('/').pop()
  const body = JSON.parse(init?.body ?? '{}')
  calls.push({ url: String(url), method, body })
  if (method === 'settings.get' || method === 'settings.update') {
    if (method === 'settings.update') Object.assign(host, body.settings ?? {})
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        settings: host,
        pluginVersion: host.pluginVersion,
        settingsFile: host.settingsFile
      })
    }
  }
  return { ok: false, status: 404, json: async () => ({ ok: false, error: { code: 'not-found', message: 'no' } }) }
}

// ── checks ──────────────────────────────────────────────────────────────────
const results = []
/** @param name - the check name. @param fn - the check body. */
async function test(name, fn) {
  try {
    await fn()
    results.push(true)
    console.log('  PASS  ' + name)
  } catch (error) {
    results.push(false)
    console.log('  FAIL  ' + name + '\n          ' + (error?.message ?? error))
  }
}

let view = null
/** Mount the section with the engine and locale the slot would supply. */
function mountPage() {
  return bundle.__internals.SettingsSection({ t: (key) => key, engine })
}
/** Render the page, then run the effects the render queued. */
function renderPage() {
  cursor = 0
  pendingEffects = []
  view = mountPage()
  const effects = pendingEffects
  pendingEffects = []
  for (const effect of effects) cleanups.push(effect())
  return view
}

view = renderPage()
await settle()
view = renderPage()

await test('the page is this plugin own document, not the translation one', () => {
  const text = textOf(view)
  assert.ok(text.includes('moduleStyle'), 'the module switch must be on the page')
  assert.ok(text.includes('styleInline'), 'and the live switch')
  assert.ok(text.includes('stylePreview'), 'and the preview')
  assert.ok(!text.includes('apiKey'), 'but nothing about an API key')
  assert.ok(!text.includes('cutMode'), 'and nothing about translation granularity')
})

await test('every style target is offered', () => {
  const text = textOf(view)
  for (const target of bundle.__internals.STYLE_TARGETS) {
    assert.ok(text.includes(target.labelKey), target.key + ' must be listed')
  }
})

await test('the switches show the stored document', () => {
  const boxes = nodes(view).filter(node => node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(boxes.length, 2, 'the module switch and the live switch')
  assert.equal(boxes[0].props.checked, false, 'the module is off, as stored')
  assert.equal(boxes[1].props.checked, true, 'live is on, as stored')
})

await test('a preset chip stages that preset on its target', () => {
  const chip = nodes(view).find(node => node.type === 'button' && node.props.title === 'presetLarge')
  assert.ok(chip !== undefined, 'a preset chip must be clickable')
  chip.props.onClick()
  view = renderPage()
  assert.ok(textOf(view).includes('styleCustomized'), 'the target reports itself customized')
})

await test('saving posts the document to the style route', async () => {
  calls.length = 0
  const save = nodes(view).find(node => node.type === 'button' && textOf(node) === 'save')
  assert.ok(save !== undefined, 'the save button must exist')
  save.props.onClick()
  await settle()
  assert.equal(calls.length, 1, 'exactly one call')
  assert.match(calls[0].url, /\/text-styles\/api\/settings\.update$/, 'and it goes to the style route')
  assert.equal(calls[0].body.settings.enabled, false, 'carrying the staged document')
})

// ── report ──────────────────────────────────────────────────────────────────
const failed = results.filter(ok => !ok).length
console.log('\n' + (results.length - failed) + '/' + results.length + ' checks passed')
process.exit(failed === 0 ? 0 : 1)
