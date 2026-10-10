/**
 * dsh-text-styles 鈥?browser half.
 *
 * One job: let the reader restyle the text that is already in the conversation.
 * It attaches to DSH's own DOM contract (`data-chat-flow-kind`,
 * `data-chat-group-part`, `data-chat-call-id`, `data-caption`, `class*="markdown"`)
 * and writes one stylesheet, so it never fights React for a node and never touches
 * the text itself.
 *
 * It shares only an attribute namespace with the translation plugin: the blocks that
 * plugin renders carry `data-dsh-tm="block"` plus `data-kind`, and the styles for
 * 鎬濈淮缈昏瘧 / 鏃佺櫧缈昏瘧 / 姝ｆ枃缈昏瘧 address them there. Without that plugin those three
 * targets simply match nothing.
 */
window.__ModuleLoader__.load({
  id: 'dsh-text-styles',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const React = react.default ?? react
    const { createElement: h, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    //#region host API
    /** Route family mounted by the host half. */
    const ROUTE = '/text-styles/api'

    /**
     * Post one method to the plugin's host route family.
     * @param method - one of settings.get | settings.update | translate | test.
     * @param payload - JSON body.
     * @param signal - optional cancellation.
     * @returns the unwrapped response payload.
     */
    async function callApi(method, payload, signal) {
      let response
      try {
        response = await fetch(`${ROUTE}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
          signal
        })
      } catch (error) {
        if (error?.name === 'AbortError') throw error
        throw new Error('无法连接宿主插件路由，请确认插件已随 Harness 启动。')
      }
      let data
      try {
        data = await response.json()
      } catch {
        data = undefined
      }
      if (!response.ok || data?.ok !== true) {
        const failure = new Error(data?.error?.message ?? `HTTP ${response.status}`)
        failure.code = data?.error?.code ?? `http-${response.status}`
        throw failure
      }
      return data
    }
/** @returns the readable half of one failed call. */
    function describeError(error) {
      if (error === null || error === undefined) return ''
      const message = error instanceof Error ? error.message : String(error)
      return message === '' ? '' : ': ' + message
    }

    //#region text style module
    /**
     * Named colours the style module can paint with.
     *
     * Everything is expressed as a theme token (or a `color-mix` over one), so a
     * light/dark switch keeps working; only the static palette entries carry a
     * literal value, and that is the entry whose token may not exist.
     */
    const STYLE_COLORS = {
      text: { zh: '主文字', en: 'Primary text', css: 'var(--dsw-alias-label-primary)' },
      soft: { zh: '次要文字', en: 'Secondary text', css: 'var(--dsw-alias-label-secondary)' },
      faint: { zh: '弱化文字', en: 'Tertiary text', css: 'var(--dsw-alias-label-tertiary)' },
      brand: { zh: '品牌色', en: 'Brand', css: 'var(--dsw-alias-brand-primary)' },
      error: { zh: '警示红', en: 'Alert red', css: 'var(--dsw-alias-state-error-primary)' },
      success: { zh: '成功绿', en: 'Success green', css: 'var(--dsw-alias-state-success-primary)' },
      amber: { zh: '琥珀', en: 'Amber', css: 'var(--dsw-static-amber-500, #f7ad31)' },
      blue: { zh: '蓝', en: 'Blue', css: 'var(--dsw-static-blue-500, #4176e6)' },
      bg1: { zh: '底色一', en: 'Layer 1', css: 'var(--dsw-alias-bg-layer-1)' },
      bg2: { zh: '底色二', en: 'Layer 2', css: 'var(--dsw-alias-bg-layer-2)' },
      tintBrand: {
        zh: '品牌淡染',
        en: 'Brand tint',
        css: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent)'
      },
      tintAmber: {
        zh: '琥珀淡染',
        en: 'Amber tint',
        css: 'color-mix(in srgb, var(--dsw-static-amber-500, #f7ad31) 18%, transparent)'
      },
      tintBlue: {
        zh: '蓝色淡染',
        en: 'Blue tint',
        css: 'color-mix(in srgb, var(--dsw-static-blue-500, #4176e6) 14%, transparent)'
      },
      none: { zh: '无', en: 'None', css: 'transparent' }
    }

    /** Font stacks. `inherit` means "emit nothing", i.e. keep DSH's own choice. */
    const STYLE_FONTS = {
      inherit: { zh: '跟随', en: 'Inherit', css: null },
      sans: {
        zh: '无衬线',
        en: 'Sans serif',
        css: '-apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif'
      },
      serif: { zh: '衬线', en: 'Serif', css: 'Georgia, "Songti SC", SimSun, serif' },
      mono: {
        zh: '等宽',
        en: 'Monospace',
        css: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace)'
      }
    }

    /**
     * The markdown containers whose inline content this module can restyle: the
     * answer, the narration between steps, and the user's own messages.
     */
    const MARKDOWN_SCOPES = [
      '[data-dsh-tm-part] div[class*="markdown"]',
      '[data-chat-flow-kind="user"] div[class*="markdown"]'
    ]

    /** @returns a selector list matching `suffix` inside every markdown scope. */
    function inMarkdown(suffix) {
      return MARKDOWN_SCOPES.map(scope => `${scope} ${suffix}`).join(', ')
    }

    /** Tool-card bodies that hold machine-ish text (command output, diffs, reads). */
    const TOOL_BODY_SELECTOR = [
      '[class*="_codeBody"]',
      '[class*="_ioText"]',
      '[class*="_diffBody"]',
      '[class*="_readBody"]',
      '[class*="_searchBody"]'
    ].map(suffix => `[data-chat-call-id] ${suffix}`).join(', ')

    /** Shorthand property groups, so each target only advertises knobs that apply. */
    const TEXT_PROPERTIES = ['font', 'size', 'lineHeight', 'weight', 'italic', 'spacing', 'color', 'opacity', 'align']
    const BOX_PROPERTIES = ['background', 'radius']
    /**
     * Spacing, offered on every target: a target that takes a border needs a way to
     * keep its text off that border, and left/right are separate because that is the
     * side a bar sits on.
     */
    const SPACE_PROPERTIES = ['paddingLeft', 'paddingRight', 'paddingY', 'marginY']
    /**
     * Edge controls. `borderSides` is the switch ("no border / one side / all four"),
     * and the other three describe the stroke; a lone width keeps the historical
     * meaning (a left bar) so the shipped presets keep working.
     */
    const EDGE_PROPERTIES = ['borderSides', 'borderWidth', 'borderStyle', 'borderColor']

    /**
     * Every text style the module can drive, with the presets offered for it.
     *
     * `real` is the conversation selector; the settings page renders its own mock
     * and every target is also matched through `[data-dsh-tm-mock="<key>"]`, so one
     * declaration list serves both the live chat and the preview.
     */
    const STYLE_TARGETS = [
      {
        key: 'body',
        group: 'content',
        labelKey: 'styleBody',
        real: '[data-dsh-tm-part="answer"] div[class*="markdown"]',
        props: [...TEXT_PROPERTIES],
        presets: {
          default: {},
          compact: { lineHeight: 1.45, size: 13 },
          roomy: { lineHeight: 2, size: 15 },
          large: { size: 16, lineHeight: 1.85 },
          serif: { font: 'serif', size: 15, lineHeight: 1.9 }
        }
      },
      {
        key: 'narration',
        group: 'content',
        labelKey: 'styleNarration',
        real: '[data-dsh-tm-part="narration"] div[class*="markdown"]',
        props: [...TEXT_PROPERTIES, 'background', 'radius'],
        presets: {
          default: {},
          quiet: { color: 'soft', lineHeight: 1.75 },
          small: { size: 12.5, color: 'faint' },
          italic: { italic: true, color: 'soft' },
          card: { background: 'bg1', radius: 6, paddingLeft: 10, paddingRight: 10, paddingY: 6, color: 'soft' }
        }
      },
      {
        key: 'reasoning',
        group: 'content',
        labelKey: 'styleReasoning',
        real: '[data-dsh-tm="block"][data-kind="reasoning"]',
        props: [...TEXT_PROPERTIES, ...BOX_PROPERTIES],
        presets: {
          default: {},
          faint: { color: 'soft', opacity: 0.88 },
          card: { background: 'bg2', radius: 6, paddingLeft: 10, paddingRight: 10, paddingY: 6, borderWidth: 0 },
          mono: { font: 'mono', size: 12.5 },
          bar: { borderWidth: 3, borderStyle: 'dashed', borderColor: 'brand', background: 'none' }
        }
      },
      {
        key: 'prose',
        group: 'content',
        labelKey: 'styleProse',
        real: '[data-dsh-tm="block"][data-kind="prose"]:not([data-dsh-tm-part="answer"])',
        props: [...TEXT_PROPERTIES, ...BOX_PROPERTIES],
        presets: {
          default: {},
          quiet: { color: 'soft', opacity: 0.9 },
          card: { background: 'tintAmber', radius: 8, paddingLeft: 10, paddingRight: 10, paddingY: 6, borderWidth: 0 },
          mono: { font: 'mono', size: 12.5 },
          bar: { borderWidth: 3, borderStyle: 'solid', borderColor: 'brand', background: 'none' }
        }
      },
      {
        key: 'proseAnswer',
        group: 'content',
        labelKey: 'styleProseAnswer',
        real: '[data-dsh-tm="block"][data-kind="prose"][data-dsh-tm-part="answer"]',
        props: [...TEXT_PROPERTIES, ...BOX_PROPERTIES],
        presets: {
          default: {},
          quiet: { color: 'soft', opacity: 0.9 },
          card: { background: 'tintBrand', radius: 8, paddingLeft: 10, paddingRight: 10, paddingY: 6, borderWidth: 0 },
          mono: { font: 'mono', size: 12.5 },
          bar: { borderWidth: 3, borderStyle: 'solid', borderColor: 'brand', background: 'none' }
        }
      },
      {
        key: 'emphasis',
        group: 'emphasis',
        labelKey: 'styleEmphasis',
        real: inMarkdown('strong, ') + inMarkdown('em'),
        props: ['font', 'size', 'weight', 'italic', 'color', 'underline', 'background'],
        presets: {
          default: {},
          bold: { weight: 700 },
          accent: { weight: 700, color: 'brand' },
          marker: { background: 'tintAmber', paddingLeft: 2, paddingRight: 2, weight: 600 },
          underline: { underline: true },
          italic: { italic: true }
        }
      },
      {
        key: 'quote',
        group: 'emphasis',
        labelKey: 'styleQuote',
        real: inMarkdown('blockquote'),
        props: [...TEXT_PROPERTIES, ...BOX_PROPERTIES],
        presets: {
          default: {},
          bar: { borderWidth: 3, borderStyle: 'solid', borderColor: 'brand', paddingLeft: 12, color: 'soft' },
          card: { background: 'bg1', radius: 8, paddingLeft: 12, paddingRight: 12, paddingY: 8, borderWidth: 0 },
          dashed: { borderWidth: 2, borderStyle: 'dashed', borderColor: 'faint', color: 'soft' },
          italic: { italic: true, color: 'soft' }
        }
      },
      {
        key: 'link',
        group: 'emphasis',
        labelKey: 'styleLink',
        real: inMarkdown('a'),
        props: ['weight', 'color', 'underline', 'opacity'],
        presets: {
          default: {},
          brand: { color: 'brand' },
          underline: { color: 'brand', underline: true },
          quiet: { color: 'soft' },
          bold: { weight: 600, color: 'brand' }
        }
      },
      {
        key: 'heading',
        group: 'structure',
        labelKey: 'styleHeading',
        real: inMarkdown(':is(h1,h2,h3,h4,h5,h6)'),
        props: [...TEXT_PROPERTIES],
        presets: {
          default: {},
          compact: { size: 15, weight: 600 },
          large: { size: 19, weight: 650, marginY: 12 },
          mono: { font: 'mono', weight: 600 },
          accent: { color: 'brand', weight: 650 }
        }
      },
      {
        key: 'list',
        group: 'structure',
        labelKey: 'styleList',
        real: inMarkdown(':is(ul,ol)'),
        props: ['size', 'lineHeight', 'color', 'spacing'],
        presets: {
          default: {},
          tight: { lineHeight: 1.5 },
          roomy: { lineHeight: 1.95, marginY: 6 },
          quiet: { color: 'soft' }
        }
      },
      {
        key: 'inlineCode',
        group: 'code',
        labelKey: 'styleInlineCode',
        real: inMarkdown(':not(pre) > code'),
        props: ['font', 'size', 'color', 'background', 'radius'],
        presets: {
          default: {},
          soft: { background: 'bg2', radius: 4, paddingLeft: 4, paddingRight: 4 },
          accent: { color: 'brand', background: 'bg1', radius: 4, paddingLeft: 4, paddingRight: 4 },
          plain: { background: 'none', color: 'text' }
        }
      },
      {
        key: 'code',
        group: 'code',
        labelKey: 'styleCode',
        real: inMarkdown('pre'),
        props: [...TEXT_PROPERTIES, ...BOX_PROPERTIES],
        presets: {
          default: {},
          compact: { size: 12, lineHeight: 1.5 },
          roomy: { size: 13.5, lineHeight: 1.8 },
          card: { background: 'bg2', radius: 8, paddingLeft: 12, paddingRight: 12, paddingY: 10 },
          tinted: { background: 'tintBrand', radius: 8 }
        }
      },
      {
        key: 'command',
        group: 'code',
        labelKey: 'styleCommand',
        real: '[data-chat-call-id] [data-caption]',
        props: [...TEXT_PROPERTIES, 'background', 'radius'],
        presets: {
          default: {},
          mono: { font: 'mono', size: 12.5, color: 'soft' },
          quiet: { color: 'faint', size: 12 },
          card: { background: 'bg1', radius: 6, paddingLeft: 8, paddingRight: 8, paddingY: 4 },
          accent: { color: 'brand', weight: 600 }
        }
      },
      {
        key: 'toolOutput',
        group: 'code',
        labelKey: 'styleToolOutput',
        real: TOOL_BODY_SELECTOR,
        props: [...TEXT_PROPERTIES, 'background', 'radius'],
        presets: {
          default: {},
          compact: { size: 12, lineHeight: 1.5 },
          roomy: { size: 13, lineHeight: 1.75 },
          dim: { opacity: 0.85, color: 'soft' },
          card: { background: 'bg1', radius: 6, paddingLeft: 10, paddingRight: 10, paddingY: 8 }
        }
      },
      {
        key: 'user',
        group: 'other',
        labelKey: 'styleUser',
        real: '[data-chat-flow-kind="user"], [data-chat-flow-kind="steering"]',
        props: [...TEXT_PROPERTIES, ...BOX_PROPERTIES],
        presets: {
          default: {},
          quiet: { color: 'soft' },
          large: { size: 15, lineHeight: 1.8 },
          card: { background: 'bg2', radius: 10, paddingLeft: 12, paddingRight: 12, paddingY: 8 },
          mono: { font: 'mono', size: 13 }
        }
      }
    ].map(target => ({
      // Every target can take spacing and a border of its own choosing — that is the
      // point of those knobs — so they are completed here rather than repeated 15x.
      ...target,
      props: [...new Set([...target.props, ...SPACE_PROPERTIES, ...EDGE_PROPERTIES])]
    }))

    /** @returns the locale key for one preset name. */
    function presetLabelKey(preset) {
      return `preset${preset.charAt(0).toUpperCase()}${preset.slice(1)}`
    }

    /**
     * The effective options of one target: its preset, then the user's overrides.
     * @param target - a style target.
     * @param entry - the persisted `{ preset, options }` entry.
     * @returns a plain options object.
     */
    function styleOptions(target, entry) {
      const name = entry !== null && typeof entry === 'object' && typeof entry.preset === 'string'
        ? entry.preset
        : 'default'
      const preset = Object.hasOwn(target.presets, name) ? target.presets[name] : {}
      const overrides = entry !== null && typeof entry === 'object' && entry.options !== null
        && typeof entry.options === 'object' ? entry.options : {}
      const options = { ...preset }
      for (const [key, value] of Object.entries(overrides)) {
        if (!target.props.includes(key)) continue
        if (value === null) delete options[key]
        else options[key] = value
      }
      return options
    }

    /**
     * Turn one options object into inline-style declarations.
     *
     * Values are strings with units, so the same object can be handed to React as
     * an inline style or serialised straight into CSS.
     * @param target - a style target (unused, but keeps the call sites symmetric).
     * @param options - the effective options.
     * @returns a `{ camelCaseProperty: value }` map.
     */
    function styleDeclarations(target, options) {
      const out = {}
      const number = key => (typeof options[key] === 'number' && Number.isFinite(options[key]) ? options[key] : null)
      const color = key => (typeof options[key] === 'string' && Object.hasOwn(STYLE_COLORS, options[key])
        ? STYLE_COLORS[options[key]].css
        : null)
      const font = typeof options.font === 'string' && Object.hasOwn(STYLE_FONTS, options.font)
        ? STYLE_FONTS[options.font].css
        : null
      if (font !== null) out.fontFamily = font
      const size = number('size')
      if (size !== null) out.fontSize = `${size}px`
      const lineHeight = number('lineHeight')
      if (lineHeight !== null) out.lineHeight = String(lineHeight)
      const weight = number('weight')
      if (weight !== null) out.fontWeight = String(weight)
      if (options.italic === true) out.fontStyle = 'italic'
      const spacing = number('spacing')
      if (spacing !== null) out.letterSpacing = `${spacing}px`
      const text = color('color')
      if (text !== null) out.color = text
      const opacity = number('opacity')
      if (opacity !== null) out.opacity = String(opacity)
      if (['left', 'center', 'right', 'justify'].includes(options.align)) out.textAlign = options.align
      const paddingLeft = number('paddingLeft')
      if (paddingLeft !== null) out.paddingLeft = `${paddingLeft}px`
      const paddingRight = number('paddingRight')
      if (paddingRight !== null) out.paddingRight = `${paddingRight}px`
      const paddingY = number('paddingY')
      if (paddingY !== null) {
        out.paddingTop = `${paddingY}px`
        out.paddingBottom = `${paddingY}px`
      }
      const marginY = number('marginY')
      if (marginY !== null) {
        out.marginTop = `${marginY}px`
        out.marginBottom = `${marginY}px`
      }
      const background = color('background')
      if (background !== null) out.background = background
      const radius = number('radius')
      if (radius !== null) out.borderRadius = `${radius}px`
      // Borders: `borderSides` decides which edges exist at all, so selecting a
      // side also *removes* the edges the target ships with (that is how a target
      // loses its bar), and every edge is written explicitly to avoid depending on
      // declaration order.
      const known = ['none', 'left', 'right', 'top', 'bottom', 'all']
      const described = ['borderWidth', 'borderStyle', 'borderColor'].some(key => options[key] !== undefined)
      let sides = typeof options.borderSides === 'string' && known.includes(options.borderSides)
        ? options.borderSides
        : null
      if (sides === null && described) sides = 'left'
      if (sides !== null) {
        const width = number('borderWidth')
        const style = ['solid', 'dashed', 'dotted'].includes(options.borderStyle) ? options.borderStyle : 'solid'
        const colour = color('borderColor') ?? 'currentColor'
        for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
          const chosen = sides === 'all' || sides === side.toLowerCase()
          out[`border${side}`] = chosen ? `${width === null ? 3 : width}px ${style} ${colour}` : 'none'
        }
      }
      if (options.underline === true) out.textDecoration = 'underline'
      return out
    }

    /** @returns `font-size:13px;…` for one declaration map. */
    function declarationsToCss(declarations) {
      return Object.entries(declarations)
        .map(([property, value]) => `${property.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}:${value}`)
        .join(';')
    }

    /** Baseline rules for the settings-page mock, so it looks like the real chat. */
    const MOCK_BASE_CSS = `
[data-dsh-tm-mock]{box-sizing:border-box}
[data-dsh-tm-mock="body"]>p,[data-dsh-tm-mock="body"]>blockquote,[data-dsh-tm-mock="body"]>pre,[data-dsh-tm-mock="body"]>ul{margin:0 0 8px}
[data-dsh-tm-mock="body"]>p:last-child,[data-dsh-tm-mock="body"]>pre:last-child,[data-dsh-tm-mock="body"]>ul:last-child{margin-bottom:0}
[data-dsh-tm-mock="body"] :is(h3){margin:10px 0 6px;font-size:16px;font-weight:600}
[data-dsh-tm-mock="body"] :is(ul,ol){padding-left:20px}
[data-dsh-tm-mock="body"] strong{font-weight:600}
[data-dsh-tm-mock="quote"]{margin:0 0 8px;padding:2px 0 2px 12px;border-left:3px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
[data-dsh-tm-mock="code"],[data-dsh-tm-mock="toolOutput"]{margin:0 0 8px;padding:8px 10px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-family:var(--ds-font-family-code,monospace);font-size:12.5px;overflow-x:auto}
[data-dsh-tm-mock="inlineCode"]{padding:1px 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);font-family:var(--ds-font-family-code,monospace);font-size:12.5px}
[data-dsh-tm-mock="link"]{color:var(--dsw-alias-brand-primary);text-decoration:none}
[data-dsh-tm-mock="command"]{color:var(--dsw-alias-label-secondary)}
[data-dsh-tm-mock="user"]{padding:6px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
[data-dsh-tm-mock="reasoning"],[data-dsh-tm-mock="prose"]{margin:2px 0 8px;padding:8px 12px;border-left:2px solid var(--dsw-alias-brand-primary);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:13px}
[data-dsh-tm-mock="prose"]{border-left:3px dashed var(--dsw-alias-label-tertiary);border-radius:0;background:transparent}
`.trim()

    /**
     * The whole style module as CSS.
     *
     * Every rule is emitted twice — once for the conversation selector and once for
     * the mock — so the settings page preview is the same CSS the chat gets.
     * @param textStyle - the persisted style document.
     * @returns CSS text for one `<style>` element.
     */
    function textStyleCss(textStyle) {
      const enabled = textStyle !== null && typeof textStyle === 'object' && textStyle.enabled === true
      const targets = textStyle !== null && typeof textStyle === 'object'
        && textStyle.targets !== null && typeof textStyle.targets === 'object' ? textStyle.targets : {}
      const rules = [MOCK_BASE_CSS]
      for (const target of STYLE_TARGETS) {
        const declarations = declarationsToCss(styleDeclarations(target, styleOptions(target, targets[target.key])))
        if (declarations === '') continue
        // The preview always explains the choice; the conversation only when asked.
        rules.push(`[data-dsh-tm-mock="${target.key}"]{${declarations}}`)
        if (enabled) rules.push(`${target.real}{${declarations}}`)
      }
      return rules.join('\n')
    }

    /**
     * Marks each assistant text part as the turn's answer or as narration.
     *
     * DSH renders both through the same flow item, and distinguishes them by
     * `answerStep` — the turn's last assistant step. The same fact is visible from
     * the DOM: within one turn the last response part *is* the answer.
     * @param document - the page document.
     * @returns how many parts were tagged.
     */
    function tagConversationParts(document) {
      const items = document.querySelectorAll('[data-chat-flow-kind="assistant-step"][data-chat-group-part="response"]')
      const last = new Map()
      for (const item of items) {
        const turn = item.closest('[data-chat-turn]')?.getAttribute('data-chat-turn') ?? ''
        last.set(turn, item)
      }
      let tagged = 0
      for (const item of items) {
        const turn = item.closest('[data-chat-turn]')?.getAttribute('data-chat-turn') ?? ''
        const part = last.get(turn) === item ? 'answer' : 'narration'
        if (item.getAttribute('data-dsh-tm-part') !== part) item.setAttribute('data-dsh-tm-part', part)
        tagged += 1
      }
      return tagged
    }

    /** Removes every tag this module wrote. */
    function untagConversationParts(document) {
      for (const item of document.querySelectorAll('[data-dsh-tm-part]')) item.removeAttribute('data-dsh-tm-part')
    }

    /**
     * The style module's own engine.
     *
     * It is deliberately independent of the translation engine: the styles must work
     * with translation switched off, and the answer/narration tag has to exist even
     * when no companion block does.
     */
    class StyleEngine {
      constructor() {
        /** @type {null | Record<string, unknown>} */
        this.settings = null
        /** The document the host last reported. */
        this.stored = null
        /** Whether the settings page holds live edits that outrank {@link stored}. */
        this.edited = false
        /** The document this engine was started with. */
        this.document = null
        this.element = null
        this.observer = null
        this.interval = null
        this.destroyed = false
      }

      /**
       * Install the stylesheet and start watching for new parts.
       * @param doc - the page document.
       */
      start(doc = document) {
        if (this.element !== null) return
        // A restart after stop() must revive the engine. Leaving `destroyed` set
        // would make retag() a no-op forever, and every style scoped to
        // data-dsh-tm-part — the answer body, the narration — would stop applying
        // without anything visibly breaking.
        this.destroyed = false
        this.document = doc
        this.element = doc.createElement('style')
        this.element.dataset.dshTm = 'style-module'
        doc.head.append(this.element)
        this.observer = new MutationObserver(() => this.retag())
        this.observer.observe(doc.body, { childList: true, subtree: true })
        this.interval = window.setInterval(() => this.retag(), 1500)
        this.paint()
      }

      /**
       * Adopt the settings page's live draft: unsaved edits that must survive a
       * settings reload (the page reloads on every visibilitychange).
       * @param textStyle - the draft document.
       */
      apply(textStyle) {
        this.edited = true
        this.settings = textStyle ?? null
        this.paint()
      }

      /**
       * Adopt the document the host reports.
       *
       * Ignored while the settings page has edits in flight: otherwise switching
       * windows would silently throw the reader's last few adjustments away and the
       * conversation would snap back to the saved look.
       *
       * @param textStyle - the persisted style document.
       */
      applyStored(textStyle) {
        this.stored = textStyle ?? null
        if (this.edited) return
        this.settings = this.stored
        this.paint()
      }

      /**
       * A save landed: the draft is now the persisted document, so it is no longer
       * protected from reloads.
       * @param textStyle - the document the host just stored.
       */
      commit(textStyle) {
        this.edited = false
        if (textStyle !== undefined) this.stored = textStyle ?? null
        this.settings = this.stored
        this.paint()
      }

      /** The settings page went away without saving: drop the draft. */
      revert() {
        if (!this.edited) return
        this.edited = false
        this.settings = this.stored
        this.paint()
      }

      /** Write the current document into the sheet and re-tag the parts. */
      paint() {
        if (this.element !== null) this.element.textContent = textStyleCss(this.settings)
        this.retag()
      }

      /** Re-tag the conversation's text parts (cheap; only writes real changes). */
      retag() {
        if (this.destroyed) return
        const doc = this.document ?? document
        if (this.settings === null || typeof this.settings !== 'object' || this.settings.enabled !== true) {
          untagConversationParts(doc)
          return
        }
        tagConversationParts(doc)
      }

      /** Remove the stylesheet, the tags and every timer. */
      stop() {
        this.destroyed = true
        this.observer?.disconnect()
        this.observer = null
        if (this.interval !== null) window.clearInterval(this.interval)
        this.interval = null
        untagConversationParts(this.document ?? document)
        this.element?.remove()
        this.element = null
      }
    }

    /** The single style engine this page owns. */
    const styleEngine = new StyleEngine()

    /** Dictionary namespace owned by this plugin. */
    const NS = 'text-styles'

    /** Simplified Chinese copy. */
    const zh = {
      nav: '文本管理器',
      title: '文本管理器',
      sessionFollow: '跟随',
      sessionOn: '开启',
      sessionOff: '关闭',
      sessionSwitchTitle: '本对话的翻译开关：跟随 = 用插件总开关；开启 = 本对话翻译，即使总开关关闭；关闭 = 本对话不翻译，即使总开关开启。点击在这三种之间切换。',
      description: '两个互相独立的模块：① 把英文思考链和思考之间的零散文字自动翻译成中文；② 自定义对话内各类文字的样式。翻译请求由本机 Host 转发到你配置的 DeepSeek 接口，API Key 只保存在本机。',
      styleLang: 'zh',
      moduleStyle: '文字样式模块',
      moduleStyleHint: '自定义对话内各类文字的字体、字号、颜色、间距与边框。与翻译模块互不影响：翻译关掉也能用。',
      moduleOff: '本模块已关闭，下面的设置不会生效。',
      badgeReasoning: '中文翻译',
      badgeAnswer: '正文翻译',
      badgeProse: '旁白翻译',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      statusEnabled: '运行中',
      loadFailed: '读取设置失败：',
      saveFailed: '保存失败：',
      styleInline: '在对话中立即生效',
      styleInlineHint: '打开后，下面的改动会立刻应用到正在显示的对话；关闭则只影响本页预览（保存后下次打开仍然生效）。',
      stylePreview: '效果预览',
      stylePreviewHint: '这段示例用与真实对话完全相同的 CSS 渲染，改任何一项都会立刻反映在它上面。',
      styleTargets: '可自定义的内容',
      styleTargetsHint: '每一项都自带一组预设；点「调整细节」可以逐项微调。',
      styleCustomize: '调整细节',
      styleCollapse: '收起',
      styleResetTarget: '回到预设',
      styleResetAll: '全部恢复默认',
      styleCustomized: '已自定义',
      styleUnusedHint: '翻译模块关闭时这一项没有可作用的对象。',
      styleGroupContent: '主要内容',
      styleGroupEmphasis: '强调与引用',
      styleGroupStructure: '结构',
      styleGroupCode: '代码与命令',
      styleGroupOther: '其他',
      styleBody: '正文',
      styleNarration: '旁白',
      styleReasoning: '思维翻译',
      styleProse: '旁白翻译',
      styleProseAnswer: '正文翻译',
      styleEmphasis: '着重',
      styleQuote: '引用',
      styleLink: '链接',
      styleHeading: '标题',
      styleList: '列表',
      styleInlineCode: '行内代码',
      styleCode: '代码块',
      styleCommand: '命令说明',
      styleToolOutput: '工具输出',
      styleUser: '我的消息',
      knobFont: '字体',
      knobSize: '字号 px',
      knobLineHeight: '行高',
      knobWeight: '字重',
      knobItalic: '斜体',
      knobSpacing: '字距 px',
      knobColor: '文字色',
      knobOpacity: '不透明度',
      knobAlign: '对齐',
      knobPaddingLeft: '左边距 px',
      knobPaddingRight: '右边距 px',
      knobPaddingY: '上下内边距 px',
      knobMarginY: '上下外边距 px',
      knobBackground: '背景',
      knobRadius: '圆角 px',
      knobBorderSides: '边框',
      knobBorderWidth: '边框粗细 px',
      knobBorderStyle: '边框样式',
      knobBorderColor: '边框颜色',
      sideNone: '无边框',
      sideLeft: '左侧竖线',
      sideRight: '右侧',
      sideTop: '上边',
      sideBottom: '下边',
      sideAll: '四周',
      knobUnderline: '下划线',
      knobAuto: '跟随',
      alignLeft: '左对齐',
      alignCenter: '居中',
      alignRight: '右对齐',
      alignJustify: '两端对齐',
      borderSolid: '实线',
      borderDashed: '虚线',
      borderDotted: '点线',
      presetDefault: '默认',
      presetCompact: '紧凑',
      presetRoomy: '宽松',
      presetLarge: '大字',
      presetSerif: '衬线',
      presetQuiet: '弱化',
      presetSmall: '小号',
      presetItalic: '斜体',
      presetCard: '卡片',
      presetFaint: '淡化',
      presetMono: '等宽',
      presetBar: '竖线',
      presetBold: '加粗',
      presetAccent: '强调色',
      presetMarker: '荧光笔',
      presetUnderline: '下划线',
      presetDashed: '虚线',
      presetBrand: '品牌色',
      presetTight: '紧凑',
      presetSoft: '淡底',
      presetPlain: '朴素',
      presetTinted: '淡染',
      presetDim: '变淡',
      styleSampleText: '示例文字',
    }

    /** English copy. */
    const en = {
      nav: 'Text Manager',
      title: 'Text Manager',
      sessionFollow: 'Follow',
      sessionOn: 'On',
      sessionOff: 'Off',
      sessionSwitchTitle: 'Translation for this conversation: Follow = use the plugin switch; On = translate it even when the plugin is off; Off = leave it alone even when the plugin is on. Click to cycle.',
      description: 'Two independent modules: (1) translate English reasoning and the narration between thinking blocks into Chinese, and (2) restyle the text inside the conversation. Requests go through the local Host to the DeepSeek endpoint you configure; the API key never leaves this machine.',
      styleLang: 'en',
      moduleStyle: 'Text style module',
      moduleStyleHint: 'Restyle the fonts, sizes, colours, spacing and edges of the text inside the conversation. Independent of the translation module: it works with translation switched off.',
      moduleOff: 'This module is off, so the settings below have no effect.',
      badgeReasoning: 'Chinese',
      badgeAnswer: 'Answer',
      badgeProse: 'Narration',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      statusEnabled: 'running',
      loadFailed: 'Could not read settings: ',
      saveFailed: 'Save failed: ',
      styleInline: 'Apply to the conversation immediately',
      styleInlineHint: 'While on, every change below lands in the conversation you are looking at; while off they only affect this page (saved settings still apply next time).',
      stylePreview: 'Preview',
      stylePreviewHint: 'This sample is rendered by exactly the CSS the real conversation gets, so every change shows up in it at once.',
      styleTargets: 'What you can restyle',
      styleTargetsHint: 'Each entry ships a set of presets; open Adjust details to fine-tune it.',
      styleCustomize: 'Adjust details',
      styleCollapse: 'Collapse',
      styleResetTarget: 'Use the preset',
      styleResetAll: 'Reset everything',
      styleCustomized: 'customized',
      styleUnusedHint: 'With the translation module off there is nothing for this entry to style.',
      styleGroupContent: 'Main content',
      styleGroupEmphasis: 'Emphasis and quotes',
      styleGroupStructure: 'Structure',
      styleGroupCode: 'Code and commands',
      styleGroupOther: 'Other',
      styleBody: 'Answer body',
      styleNarration: 'Narration',
      styleReasoning: 'Reasoning translation',
      styleProse: 'Narration translation',
      styleProseAnswer: 'Answer translation',
      styleEmphasis: 'Emphasis',
      styleQuote: 'Quote',
      styleLink: 'Link',
      styleHeading: 'Heading',
      styleList: 'List',
      styleInlineCode: 'Inline code',
      styleCode: 'Code block',
      styleCommand: 'Command caption',
      styleToolOutput: 'Tool output',
      styleUser: 'My messages',
      knobFont: 'Font',
      knobSize: 'Size px',
      knobLineHeight: 'Line height',
      knobWeight: 'Weight',
      knobItalic: 'Italic',
      knobSpacing: 'Letter spacing px',
      knobColor: 'Text colour',
      knobOpacity: 'Opacity',
      knobAlign: 'Align',
      knobPaddingLeft: 'Left padding px',
      knobPaddingRight: 'Right padding px',
      knobPaddingY: 'Padding top/bottom px',
      knobMarginY: 'Margin top/bottom px',
      knobBackground: 'Background',
      knobRadius: 'Radius px',
      knobBorderSides: 'Border',
      knobBorderWidth: 'Border width px',
      knobBorderStyle: 'Border style',
      knobBorderColor: 'Border colour',
      sideNone: 'No border',
      sideLeft: 'Left bar',
      sideRight: 'Right',
      sideTop: 'Top',
      sideBottom: 'Bottom',
      sideAll: 'All sides',
      knobUnderline: 'Underline',
      knobAuto: 'Inherit',
      alignLeft: 'Left',
      alignCenter: 'Centre',
      alignRight: 'Right',
      alignJustify: 'Justify',
      borderSolid: 'Solid',
      borderDashed: 'Dashed',
      borderDotted: 'Dotted',
      presetDefault: 'Default',
      presetCompact: 'Compact',
      presetRoomy: 'Roomy',
      presetLarge: 'Large',
      presetSerif: 'Serif',
      presetQuiet: 'Quiet',
      presetSmall: 'Small',
      presetItalic: 'Italic',
      presetCard: 'Card',
      presetFaint: 'Faint',
      presetMono: 'Monospace',
      presetBar: 'Bar',
      presetBold: 'Bold',
      presetAccent: 'Accent',
      presetMarker: 'Marker',
      presetUnderline: 'Underline',
      presetDashed: 'Dashed',
      presetBrand: 'Brand',
      presetTight: 'Tight',
      presetSoft: 'Soft fill',
      presetPlain: 'Plain',
      presetTinted: 'Tinted',
      presetDim: 'Dimmed',
      styleSampleText: 'Sample text',
    }

    const styles = {
      page: { display: 'flex', flexDirection: 'column', gap: '18px', maxWidth: '760px' },
      section: { display: 'flex', flexDirection: 'column', gap: '14px' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px' },
      label: { fontSize: '13px', color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: '18px' },
      input: {
        boxSizing: 'border-box',
        width: '100%',
        padding: '6px 10px',
        fontSize: '13px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 'var(--dsw-radius-sm)',
        outline: 'none'
      },
      row: { display: 'flex', alignItems: 'center', gap: '8px' },
      checkbox: { width: '14px', height: '14px', accentColor: 'var(--dsw-alias-brand-primary)' },
      sessionSwitch: {
        appearance: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        height: '26px',
        padding: '0 10px',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: 1,
        background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-sm)',
        cursor: 'pointer'
      },
      sessionSwitchDot: {
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        background: 'currentColor',
        opacity: 0.6
      },
      button: {
        appearance: 'none',
        padding: '5px 12px',
        fontSize: '13px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 'var(--dsw-radius-sm)',
        cursor: 'pointer'
      },
      primary: {
        appearance: 'none',
        padding: '5px 14px',
        fontSize: '13px',
        color: 'var(--dsw-alias-bg-base)',
        background: 'var(--dsw-alias-brand-primary)',
        border: '1px solid var(--dsw-alias-brand-primary)',
        borderRadius: 'var(--dsw-radius-sm)',
        cursor: 'pointer'
      },
      ok: { fontSize: '12px', color: 'var(--dsw-alias-state-success-primary)' },
      warn: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
      bad: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
      muted: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      mono: {
        boxSizing: 'border-box',
        width: '100%',
        minHeight: '88px',
        resize: 'vertical',
        padding: '8px 10px',
        fontSize: '12px',
        fontFamily: 'var(--ds-font-family-code, monospace)',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 'var(--dsw-radius-sm)',
        outline: 'none'
      },
      result: {
        boxSizing: 'border-box',
        width: '100%',
        maxHeight: '220px',
        overflow: 'auto',
        padding: '8px 10px',
        fontSize: '13px',
        lineHeight: '1.7',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 'var(--dsw-radius-sm)'
      },
      disabled: { opacity: 0.55, cursor: 'default' },
      group: { display: 'flex', flexDirection: 'column', gap: '10px' },
      groupTitle: {
        fontSize: '12px',
        letterSpacing: '.04em',
        color: 'var(--dsw-alias-label-tertiary)',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        paddingBottom: '4px'
      },
      target: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '8px 10px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 'var(--dsw-radius-sm)',
        background: 'var(--dsw-alias-bg-layer-1)'
      },
      targetHead: { display: 'flex', alignItems: 'center', gap: '8px' },
      targetName: { flex: '1 1 auto', fontSize: '13px', color: 'var(--dsw-alias-label-primary)' },
      badgeCustom: {
        flex: 'none',
        padding: '0 6px',
        fontSize: '11px',
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        borderRadius: 'var(--dsw-radius-sm)'
      },
      chips: { display: 'flex', flexWrap: 'wrap', gap: '6px' },
      chip: {
        appearance: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        minWidth: '64px',
        padding: '4px 8px',
        textAlign: 'left',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 'var(--dsw-radius-sm)',
        cursor: 'pointer'
      },
      chipActive: {
        borderColor: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-label-primary)',
        boxShadow: '0 0 0 1px var(--dsw-alias-brand-primary) inset'
      },
      chipSample: { display: 'block', fontSize: '12px', lineHeight: '16px', overflow: 'hidden' },
      knobs: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: '6px 12px',
        paddingTop: '6px',
        borderTop: '1px dashed var(--dsw-alias-border-l1)'
      },
      knob: { display: 'flex', alignItems: 'center', gap: '6px' },
      knobLabel: { flex: '0 0 92px', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' },
      knobRange: { flex: '1 1 auto', minWidth: '60px', accentColor: 'var(--dsw-alias-brand-primary)' },
      knobSelect: {
        flex: '1 1 auto',
        minWidth: '60px',
        fontSize: '12px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 'var(--dsw-radius-sm)'
      },
      knobValue: { flex: '0 0 34px', fontSize: '11px', textAlign: 'right', color: 'var(--dsw-alias-label-tertiary)' },
      clearKnob: {
        appearance: 'none',
        flex: 'none',
        padding: '0 4px',
        fontSize: '11px',
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-tertiary)',
        background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 'var(--dsw-radius-sm)',
        cursor: 'pointer'
      },
      mockBox: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '12px 14px',
        fontSize: '13px',
        lineHeight: '1.7',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 'var(--dsw-radius-sm)'
      },
      mockTool: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '8px 10px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 'var(--dsw-radius-sm)'
      },
      mockBadge: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' }
    }

    function Field({ label, hint, children }) {
      return h('div', { style: styles.field },
        h('label', { style: styles.label }, label),
        children,
        hint === undefined || hint === '' ? null : h('div', { style: styles.hint }, hint))
    }

    /** Model ids offered before anything has been fetched from the endpoint. */
    const SUGGESTED_MODELS = ['deepseek-chat', 'deepseek-reasoner']

    /** The sample the self-test translates; written to look like real reasoning. */
    const SAMPLE_REASONING = [
      'Let me look at the failing assertion again before I touch the parser.',
      '',
      'The tokenizer drops trailing whitespace, so the expected column index is off by one. I will fix the tokenizer first, then re-run the suite to confirm nothing else regressed.'
    ].join('\n')

    /**
     * Merge the provider's cached model ids with the built-in suggestions.
     * @param cached - ids persisted by the host.
     * @returns a de-duplicated, sorted list that always keeps the defaults.
     */
    function mergeModels(cached) {
      const seen = new Set(SUGGESTED_MODELS)
      for (const id of Array.isArray(cached) ? cached : []) {
        if (typeof id === 'string' && id.trim() !== '') seen.add(id.trim())
      }
      return [...seen]
    }

    /**
     * Run one text through the engine's real segmentation and the host's real
     * translation route, joining the pieces exactly as the live translator does.
     * @param text - the sample to translate.
     * @param maxChars - the configured per-request cap.
     * @param skippedLabel - copy used when the Host skips a segment.
     * @returns `{ segments, text }`.
     */
    async function runSegmentedTranslation(text, maxChars, skippedLabel) {
      const segments = []
      let rest = text
      let guard = 0
      while (rest.trim() !== '' && guard < 200) {
        guard += 1
        const picked = pickCut(rest, false, maxChars, true)
        if (picked.cut <= 0) break
        const segment = rest.slice(0, picked.cut).replace(/\s+$/, '')
        rest = rest.slice(picked.cut).replace(/^\s+/, '')
        if (segment !== '') segments.push({ segment, sep: picked.sep })
      }
      const pieces = []
      for (const part of segments) {
        const data = await callApi('translate', { text: part.segment, force: true })
        const piece = data.skipped === true ? skippedLabel : String(data.text ?? '')
        if (piece === '') continue
        pieces.push({ text: piece, sep: part.sep })
      }
      return { segments: segments.length, text: joinParts(pieces) }
    }

    /**
     * The knob each target property exposes in the settings page.
     *
     * `kind` picks the control: a range for numbers, a checkbox for flags, a
     * palette/modifier select for anything enumerated. `fallback` is where the range
     * starts when neither the preset nor the user supplies a value.
     */
    const STYLE_KNOBS = {
      font: { labelKey: 'knobFont', kind: 'font' },
      size: { labelKey: 'knobSize', kind: 'number', min: 9, max: 28, step: 0.5, fallback: 13 },
      lineHeight: { labelKey: 'knobLineHeight', kind: 'number', min: 1, max: 2.6, step: 0.05, fallback: 1.7 },
      weight: { labelKey: 'knobWeight', kind: 'weight' },
      italic: { labelKey: 'knobItalic', kind: 'bool' },
      spacing: { labelKey: 'knobSpacing', kind: 'number', min: -1, max: 3, step: 0.1, fallback: 0 },
      color: { labelKey: 'knobColor', kind: 'color' },
      opacity: { labelKey: 'knobOpacity', kind: 'number', min: 0.3, max: 1, step: 0.02, fallback: 1 },
      align: { labelKey: 'knobAlign', kind: 'choice', choices: [['left', 'alignLeft'], ['center', 'alignCenter'], ['right', 'alignRight'], ['justify', 'alignJustify']] },
      paddingLeft: { labelKey: 'knobPaddingLeft', kind: 'number', min: 0, max: 48, step: 1, fallback: 0 },
      paddingRight: { labelKey: 'knobPaddingRight', kind: 'number', min: 0, max: 48, step: 1, fallback: 0 },
      paddingY: { labelKey: 'knobPaddingY', kind: 'number', min: 0, max: 24, step: 1, fallback: 0 },
      marginY: { labelKey: 'knobMarginY', kind: 'number', min: -8, max: 32, step: 1, fallback: 0 },
      background: { labelKey: 'knobBackground', kind: 'color' },
      radius: { labelKey: 'knobRadius', kind: 'number', min: 0, max: 20, step: 1, fallback: 0 },
      borderSides: {
        labelKey: 'knobBorderSides',
        kind: 'choice',
        choices: [['none', 'sideNone'], ['left', 'sideLeft'], ['right', 'sideRight'],
          ['top', 'sideTop'], ['bottom', 'sideBottom'], ['all', 'sideAll']]
      },
      borderWidth: { labelKey: 'knobBorderWidth', kind: 'number', min: 0, max: 8, step: 1, fallback: 3 },
      borderStyle: { labelKey: 'knobBorderStyle', kind: 'choice', choices: [['solid', 'borderSolid'], ['dashed', 'borderDashed'], ['dotted', 'borderDotted']] },
      borderColor: { labelKey: 'knobBorderColor', kind: 'color' },
      underline: { labelKey: 'knobUnderline', kind: 'bool' }
    }

    /** Weight values worth offering. */
    const STYLE_WEIGHTS = [400, 500, 600, 650, 700, 800]

    /** Group order for the target list. */
    const STYLE_GROUPS = ['content', 'emphasis', 'structure', 'code', 'other']

    /**
    /**
     * One target's controls: its preset chips plus, on demand, every knob.
     *
     * A chip renders its own sample with that preset's declarations, so a preset is
     * visible rather than merely named.
     */
    function StyleTargetRow({ t, h, lang, target, entry, open, onToggle, onPreset, onKnob }) {
      const options = styleOptions(target, entry)
      const overrides = entry !== null && typeof entry === 'object' && entry.options !== null
        && typeof entry.options === 'object' ? entry.options : {}
      // An entry only exists when the user moved away from the default preset, so
      // its presence *is* the "customized" fact.
      const customized = entry !== null && typeof entry === 'object'
      const presetName = entry !== null && typeof entry === 'object' && typeof entry.preset === 'string'
        ? entry.preset
        : 'default'

      /** One knob row, driven entirely by its descriptor. */
      const knobRow = (property) => {
        const knob = STYLE_KNOBS[property]
        if (knob === undefined) return null
        const effective = options[property]
        const clear = () => onKnob(target, property, undefined)
        const pick = (value) => onKnob(target, property, value)
        let control
        if (knob.kind === 'number') {
          const value = typeof effective === 'number' ? effective : knob.fallback
          control = [
            h('input', {
              key: 'range',
              type: 'range',
              style: styles.knobRange,
              min: knob.min,
              max: knob.max,
              step: knob.step,
              value,
              onChange: (event) => pick(Number(event.target.value))
            }),
            h('span', { key: 'value', style: styles.knobValue }, String(value))
          ]
        } else if (knob.kind === 'bool') {
          control = h('input', {
            type: 'checkbox',
            style: styles.checkbox,
            checked: effective === true,
            onChange: (event) => pick(event.target.checked)
          })
        } else {
          const choices = knob.kind === 'font'
            ? Object.entries(STYLE_FONTS).map(([key, font]) => ({ value: key, label: font[lang] }))
            : knob.kind === 'weight'
              ? STYLE_WEIGHTS.map(weight => ({ value: String(weight), label: String(weight) }))
              : knob.kind === 'choice'
                ? knob.choices.map(([value, key]) => ({ value, label: t(key) }))
                : Object.entries(STYLE_COLORS).map(([key, colour]) => ({ value: key, label: colour[lang] }))
          control = h('select', {
            style: styles.knobSelect,
            value: typeof effective === 'string' ? effective : '',
            onChange: (event) => pick(event.target.value === '' ? undefined : event.target.value)
          },
          h('option', { value: '' }, t('knobAuto')),
          choices.map(choice => h('option', { key: choice.value, value: choice.value }, choice.label)))
        }
        const body = Array.isArray(control) ? control : [control]
        return h('div', { key: property, style: styles.knob },
          h('span', { style: styles.knobLabel }, t(knob.labelKey)),
          ...body,
          overrides[property] === undefined
            ? null
            : h('button', { type: 'button', style: styles.clearKnob, title: t('knobAuto'), onClick: clear }, '×'))
      }

      return h('div', { style: styles.target },
        h('div', { style: styles.targetHead },
          h('span', { style: styles.targetName }, t(target.labelKey)),
          customized ? h('span', { style: styles.badgeCustom }, t('styleCustomized')) : null,
          h('button', {
            type: 'button',
            style: styles.button,
            onClick: () => onToggle(target.key)
          }, open ? t('styleCollapse') : t('styleCustomize')),
          customized
            ? h('button', {
              type: 'button',
              style: styles.button,
              onClick: () => onPreset(target, 'default')
            }, t('styleResetTarget'))
            : null),
        h('div', { style: styles.chips },
          Object.entries(target.presets).map(([presetKey]) => {
            const declarations = styleDeclarations(target, styleOptions(target, { preset: presetKey, options: {} }))
            return h('button', {
              key: presetKey,
              type: 'button',
              style: { ...styles.chip, ...(presetKey === presetName ? styles.chipActive : {}) },
              title: t(presetLabelKey(presetKey)),
              onClick: () => onPreset(target, presetKey)
            },
            h('span', { style: styles.chipSample }, t(presetLabelKey(presetKey))),
            // The sample keeps a fixed height so the chip row stays tidy, but every
            // other property of the preset shows through.
            h('span', {
              style: {
                ...declarations,
                display: 'block',
                lineHeight: '18px',
                maxHeight: '18px',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                textOverflow: 'ellipsis'
              }
            }, `${t('styleSampleText')} Aa`))
          })),
        open ? h('div', { style: styles.knobs }, target.props.map(knobRow)) : null)
    }

    /**
     * The conversation-text-style module's settings surface.
     *
     * The sample above the controls is rendered by the very CSS the chat gets, and
     * the preset chips render themselves, so a choice is visible before it is saved.
     */
    function StyleModuleSection({ t, h, textStyle, translationOn, patchTextStyle, patchTarget }) {
      const [open, setOpen] = useState('')
      const lang = t('styleLang') === 'en' ? 'en' : 'zh'
      const enabled = textStyle.enabled === true
      const targets = textStyle.targets !== null && typeof textStyle.targets === 'object' ? textStyle.targets : {}

      /** Choose a preset; a preset always starts from a clean slate. */
      const onPreset = (target, preset) => {
        patchTarget(target.key, preset === 'default' ? null : { preset, options: {} })
      }

      /** Write, or clear, one option override. */
      const onKnob = (target, property, value) => {
        const entry = targets[target.key] ?? { preset: 'default', options: {} }
        const options = { ...(entry.options ?? {}) }
        if (value === undefined) delete options[property]
        else options[property] = value
        const preset = typeof entry.preset === 'string' ? entry.preset : 'default'
        if (preset === 'default' && Object.keys(options).length === 0) patchTarget(target.key, null)
        else patchTarget(target.key, { preset, options })
      }

      /** The sample: real conversation chrome, entirely rendered by the module's CSS. */
      const mock = h('div', { style: styles.mockBox },
        h('div', { 'data-dsh-tm-mock': 'user' },
          h('strong', null, `${t('styleUser')}：`),
          '把这几段话的样式分开调一下。'),
        h('div', { 'data-dsh-tm-mock': 'reasoning' },
          h('div', { style: styles.mockBadge }, t('badgeReasoning')),
          h('div', null, '让我先确认一下分段顺序的逻辑，再决定要不要改成卡片样式。')),
        h('div', { 'data-dsh-tm-mock': 'narration' },
          h('p', { style: { margin: 0 } }, 'Now let me run the suite and compare both outputs before touching the stylesheet.')),
        h('div', { 'data-dsh-tm-mock': 'prose' },
          h('div', { style: styles.mockBadge }, t('badgeProse')),
          h('div', null, '现在把测试跑一遍，然后对照两边的输出。')),
        h('div', { 'data-dsh-tm-mock': 'body' },
          h('h3', { style: { margin: '10px 0 6px' } }, '结论'),
          h('p', { style: { margin: '0 0 8px' } },
            '段落顺序由 ',
            h('strong', { 'data-dsh-tm-mock': 'emphasis' }, '源序槽位'),
            ' 保证，见 ',
            h('a', {
              'data-dsh-tm-mock': 'link',
              href: '#',
              onClick: (event) => event.preventDefault()
            }, '说明'),
            ' 与 ',
            h('code', { 'data-dsh-tm-mock': 'inlineCode' }, 'joinParts()'),
            '。'),
          h('blockquote', { 'data-dsh-tm-mock': 'quote' }, '切点不落在未闭合的代码围栏里。'),
          h('ul', { 'data-dsh-tm-mock': 'list', style: { margin: '0 0 8px', paddingLeft: '20px' } },
            h('li', null, '第一项'),
            h('li', null, '第二项')),
          h('pre', { 'data-dsh-tm-mock': 'code', style: { margin: '0 0 8px' } },
            'const parts = joinParts(state.parts)'),
          h('div', { style: styles.mockTool },
            h('div', { 'data-dsh-tm-mock': 'command' }, '运行测试：node test/host.test.mjs'),
            h('pre', { 'data-dsh-tm-mock': 'toolOutput', style: { margin: 0 } }, '37/37 checks passed'))),
        h('div', { 'data-dsh-tm-mock': 'proseAnswer' },
          h('div', { style: styles.mockBadge }, t('badgeAnswer')),
          h('div', null, '（回答正文的中文翻译块：只在正文含英文时出现）')))

      const groups = STYLE_GROUPS.map(group => {
        const members = STYLE_TARGETS.filter(target => target.group === group)
        if (members.length === 0) return null
        const titleKey = `styleGroup${group.charAt(0).toUpperCase()}${group.slice(1)}`
        return h('div', { key: group, style: styles.group },
          h('div', { style: styles.groupTitle }, t(titleKey)),
          ...members.map(target => h(StyleTargetRow, {
            key: target.key,
            t,
            h,
            lang,
            target,
            entry: targets[target.key] ?? null,
            open: open === target.key,
            onToggle: (key) => setOpen(current => (current === key ? '' : key)),
            onPreset,
            onKnob
          })))
      }).filter(node => node !== null)

      return h('div', { style: styles.section },
        h('div', { style: styles.label }, t('moduleStyle')),
        h(Field, { label: t('styleInline'), hint: t('styleInlineHint') },
          h('div', { style: styles.row },
            h('input', {
              type: 'checkbox',
              style: styles.checkbox,
              checked: textStyle.live === true,
              onChange: (event) => patchTextStyle({ live: event.target.checked })
            }))),
        h(Field, { label: t('stylePreview'), hint: t('stylePreviewHint') }, mock),
        h(Field, { label: t('styleTargets'), hint: t('styleTargetsHint') },
          h('div', { style: styles.row },
            h('button', {
              type: 'button',
              style: styles.button,
              onClick: () => patchTextStyle({ targets: {} })
            }, t('styleResetAll')),
            enabled ? null : h('span', { style: styles.warn }, t('moduleOff')))),
        ...groups,
        translationOn ? null : h('div', { style: styles.hint }, t('styleUnusedHint')))
    }

    /**
     * The per-conversation translation switch, rendered in the session header.
     *
     * Three states, because "follow the plugin switch" is a real choice of its own:
     * 开启 and 关闭 override the plugin switch in both directions, which is what lets
     * one conversation keep translating while the plugin is switched off, and stay
     * quiet while it is on.
     */
    function SessionSwitchButton(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const engine = props.engine
      const state = useSyncExternalStore(engine.subscribe, engine.getSnapshot)
      const sessionId = typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : null
      // The header is what tells the engine which conversation is on screen.
      useEffect(() => { engine.setSession(sessionId) }, [sessionId])
      const known = state.sessionId === sessionId
      const mode = known && (state.sessionMode === 'on' || state.sessionMode === 'off') ? state.sessionMode : 'follow'
      const text = mode === 'on' ? t('sessionOn') : mode === 'off' ? t('sessionOff') : t('sessionFollow')
      const color = mode === 'on'
        ? 'var(--dsw-alias-label-primary)'
        : mode === 'off' ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-label-secondary)'
      return h('button', {
        type: 'button',
        title: t('sessionSwitchTitle'),
        'data-mode': mode,
        'data-known': known ? 'yes' : 'no',
        style: { ...styles.sessionSwitch, color },
        onClick: () => { void engine.cycleSessionMode() }
      },
      h('span', { style: styles.sessionSwitchDot }),
      h('span', null, text))
    }

    /**
    /**
     * The 文字样式 settings page.
     *
     * It owns exactly one document — the style targets — and talks to its own host
     * route, so the page works whether or not the translation plugin is installed.
     */
    function SettingsSection(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const engine = props.engine
      const [loaded, setLoaded] = useState(false)
      const [draft, setDraft] = useState({ enabled: false, live: true, targets: {} })
      const [hostVersion, setHostVersion] = useState('')
      const [settingsFile, setSettingsFile] = useState('')
      const [busy, setBusy] = useState('')
      const [message, setMessage] = useState(null)

      const patchTextStyle = (fields) => setDraft((current) => ({ ...current, ...fields }))

      /**
       * Replace (or clear) one target's { preset, options } entry.
       * @param key - the target key.
       * @param entry - the new entry, or null to fall back to the default preset.
       */
      const patchTarget = (key, entry) => setDraft((current) => {
        const targets = { ...current.targets }
        if (entry === null) delete targets[key]
        else targets[key] = entry
        return { ...current, targets }
      })

      /**
       * Whether the translation plugin looks present.
       *
       * The two plugins are independent, so the styles that only apply to translation
       * blocks can only matter when that plugin is loaded. Its stylesheet id is the
       * marker: the blocks themselves appear only after something is translated.
       */
      const translationPresent = typeof document !== 'undefined' && typeof document.querySelector === 'function'
        ? document.querySelector('style[data-plugin-css^="dsh-text-translator/"]') !== null
        : false

      // Live styling: with the switch on, every edit repaints the conversation that
      // is actually on screen, which is the most direct preview there is.
      useEffect(() => {
        if (draft.live !== true) {
          // Live off means "stop pushing my draft": the conversation goes back to the
          // saved look until the next save.
          engine.revert()
          return
        }
        engine.apply(draft)
      }, [draft])

      // Leaving the page without saving gives the conversation its saved look back.
      useEffect(() => () => engine.revert(), [])

      useEffect(() => {
        let cancelled = false
        void (async () => {
          try {
            const data = await callApi('settings.get')
            if (cancelled) return
            const stored = data !== null && typeof data === 'object' ? data.settings ?? {} : {}
            setDraft({
              enabled: stored.enabled === true,
              live: stored.live !== false,
              targets: stored.targets !== null && typeof stored.targets === 'object' ? stored.targets : {}
            })
            setHostVersion(typeof data?.pluginVersion === 'string' ? data.pluginVersion : '')
            setSettingsFile(typeof data?.settingsFile === 'string' ? data.settingsFile : '')
          } catch (error) {
            if (!cancelled) setMessage({ kind: 'bad', text: t('loadFailed') + describeError(error) })
          }
          if (!cancelled) setLoaded(true)
        })()
        return () => { cancelled = true }
      }, [])

      /** Persist the staged document and hand it to the engine as the saved one. */
      const save = async () => {
        setBusy('save')
        setMessage(null)
        try {
          const data = await callApi('settings.update', { settings: draft })
          const stored = data !== null && typeof data === 'object' ? data.settings ?? {} : {}
          setDraft({
            enabled: stored.enabled === true,
            live: stored.live !== false,
            targets: stored.targets !== null && typeof stored.targets === 'object' ? stored.targets : {}
          })
          engine.commit(stored)
          setMessage({ kind: 'ok', text: t('saved') })
          return true
        } catch (error) {
          setMessage({ kind: 'bad', text: t('saveFailed') + describeError(error) })
          return false
        } finally {
          setBusy('')
        }
      }

      return h('div', { style: styles.page },
        h('div', { style: styles.section },
          h('div', { style: styles.label }, t('title')),
          h('div', { style: styles.hint }, t('description')),
          h('div', { style: styles.hint }, `${t('statusEnabled')} v${hostVersion} · ${settingsFile}`)),

        h('div', { style: styles.section },
          h('label', { style: styles.row },
            h('input', {
              type: 'checkbox',
              style: styles.checkbox,
              checked: draft.enabled === true,
              onChange: (event) => patchTextStyle({ enabled: event.target.checked })
            }),
            h('span', { style: styles.label }, t('moduleStyle')),
            h('span', { style: styles.hint }, t('moduleStyleHint'))),
          ),

        h(StyleModuleSection, {
          t,
          h,
          textStyle: draft,
          translationOn: translationPresent,
          patchTextStyle,
          patchTarget
        }),

        h('div', { style: styles.row },
          h('button', {
            type: 'button',
            style: styles.primary,
            disabled: busy !== '' || !loaded,
            onClick: () => { void save() }
          }, busy === 'save' ? t('saving') : t('save'))),

        message === null ? null : h('div', { style: message.kind === 'ok' ? styles.ok : styles.bad }, message.text))
    }
    //#endregion

    /** Cordis services this browser half needs. */
    const inject = ['slots', 'locale']

    /**
     * Mount the browser half.
     * @param ctx - the Cordis browser context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'text-styles: dictionaries')

      // The engine owns its own stylesheet and observer. Nothing else in this plugin
      // touches the page, so it is also the whole runtime cost of the plugin.
      ctx.effect(() => {
        styleEngine.start(document)
        return () => styleEngine.stop()
      }, 'text-styles: engine')

      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'text-styles',
        order: 230,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ engine: styleEngine })
      }, SettingsSection)), 'text-styles: settings page')
    }

    exports.NS = NS
    exports.apply = apply
    exports.inject = inject
    /**
     * Internals exposed for the offline test suite (test/style.test.mjs) and for
     * in-page debugging. The runner ignores unknown exports.
     */
    exports.__internals = {
      SettingsSection,
      StyleEngine,
      styleEngine,
      STYLE_TARGETS,
      STYLE_COLORS,
      STYLE_FONTS,
      STYLE_KNOBS,
      STYLE_GROUPS,
      STYLE_WEIGHTS,
      styleOptions,
      styleDeclarations,
      declarationsToCss,
      textStyleCss,
      tagConversationParts,
      untagConversationParts,
      presetLabelKey,
      inMarkdown,
      MOCK_BASE_CSS,
      zh,
      en
    }

    return module.exports
  }
})
