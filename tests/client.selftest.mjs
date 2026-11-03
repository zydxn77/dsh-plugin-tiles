/**
 * 客户端自检：真渲染组件，不启动浏览器。
 *
 * 重点：
 *   ① 挂到哪个槽、id 是什么（挂错了整块不会出现）
 *   ② hook 必须全部在提前 return 之前（React #310）
 *   ③ 方块真的画出来、状态真的反映在样式上
 *
 * 跑法：node tests/client.selftest.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'lib', 'client.js')
const source = fs.readFileSync(clientPath, 'utf8')

let pass = 0
const failures = []
function check(name, fn) {
  try {
    fn()
    pass += 1
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`)
  }
}
function ok(v, label) {
  if (!v) throw new Error(label || '断言失败')
}
function eq(a, b, label) {
  const x = JSON.stringify(a)
  const y = JSON.stringify(b)
  if (x !== y) throw new Error(`${label || ''} 期望 ${y}，实际 ${x}`)
}

// ————————————————————————————————————————————————————————————
// React 桩件
// ————————————————————————————————————————————————————————————

function createReact() {
  let hooks = []
  let cursor = 0
  let effects = []
  let hookCalls = 0

  class Component {
    constructor(props) {
      this.props = props || {}
      this.state = {}
    }
    setState(patch) {
      this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) }
    }
  }

  const React = {
    Component,
    // 真 React 里 Fragment 是个 symbol；桩件里给个不可调用的标记就够了，
    // expand() 只对 function 类型的节点求值
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      hookCalls += 1
      const i = cursor++
      if (hooks[i] === undefined) hooks[i] = [typeof initial === 'function' ? initial() : initial]
      const st = hooks[i]
      return [
        st[0],
        (next) => {
          st[0] = typeof next === 'function' ? next(st[0]) : next
        },
      ]
    },
    useRef(initial) {
      hookCalls += 1
      const i = cursor++
      if (hooks[i] === undefined) hooks[i] = { current: initial }
      return hooks[i]
    },
    useCallback(fn) {
      hookCalls += 1
      cursor++
      return fn
    },
    useEffect(fn) {
      hookCalls += 1
      cursor++
      effects.push(fn)
    },
    __begin() {
      cursor = 0
      effects = []
      hookCalls = 0
    },
    __hooks() {
      return hookCalls
    },
    __effects() {
      return effects
    },
    __resetAll() {
      hooks = []
      cursor = 0
      effects = []
      hookCalls = 0
    },
  }
  return React
}

// ————————————————————————————————————————————————————————————
// 沙箱
// ————————————————————————————————————————————————————————————

const React = createReact()
let captured = null

const win = {
  __DESK_TEST__: true,
  __ModuleLoader__: {
    load: (o) => {
      captured = o
    },
  },
  localStorage: (() => {
    const m = new Map()
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    }
  })(),
}

/** 记下所有 fetch，用来验证点方块真的发了开关请求 */
const fetchCalls = []
/** 下一次 /list 的响应（用例可以改它，测「已静音」时的按钮文案） */
let nextList = { ok: true, plugins: [] }
const sandbox = {
  window: win,
  document: { addEventListener() {}, removeEventListener() {} },
  console: { log() {}, warn() {}, error() {} },
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: (url, opts) => {
    fetchCalls.push({ url: String(url), opts: opts || null })
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(nextList) })
  },
  Math,
  Date,
  JSON,
  Set,
  Map,
  Array,
  Object,
  Number,
  String,
  Boolean,
  Symbol,
  Error,
  Promise,
  RegExp,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

ok(captured !== null, '应当调用 __ModuleLoader__.load')
eq(captured.id, 'dsh-plugin-tiles', '模块 id')

const mod = captured.factory((n) => {
  if (n === 'react') return React
  throw new Error(`不该 require ${n}`)
})

check('模块导出 apply 与自检出口', () => {
  ok(typeof mod.apply === 'function', 'apply')
  ok(mod.__test !== undefined, '沙箱里应当挂上 __test')
  eq(mod.__test.SLOT, 'conversation.session.header.actions', '槽位名')
  eq(mod.__test.ROUTE, '/.dsh-plugin-tiles', '路由前缀')
})

// ————————————————————————————————————————————————————————————
// 注册
// ————————————————————————————————————————————————————————————

let registered = null
check('注册进会话标题旁的动作槽，id 正确、order 有值', () => {
  const regs = []
  mod.apply({
    get: () => undefined,
    inject: (deps, cb) => {
      ok(deps.includes('slots'), '应当 inject slots')
      cb({
        slots: {
          inject: (slot, fn) => {
            eq(slot, 'conversation.session.header.actions', '挂载的槽')
            fn()
          },
          register: (opts, comp) => {
            regs.push({ opts, comp })
            return () => {}
          },
        },
      })
    },
  })
  eq(regs.length, 1, '注册数')
  registered = regs[0]
  eq(registered.opts.id, 'plugin-tiles', 'id')
  eq(registered.opts.name, 'conversation.session.header.actions', 'name 要和槽一致')
  ok(typeof registered.opts.order === 'number', 'order 要有')
})

// ————————————————————————————————————————————————————————————
// 渲染
// ————————————————————————————————————————————————————————————

function expand(node, max = 10) {
  let tree = node
  let guard = 0
  while (tree && typeof tree === 'object' && typeof tree.type === 'function' && guard < max) {
    const type = tree.type
    if (type.prototype && typeof type.prototype.render === 'function') {
      tree = new type(tree.props).render()
    } else {
      tree = type(tree.props)
    }
    guard += 1
  }
  return tree
}

function findFirst(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out
  // 子节点常常是数组（map 出来的方块、尾巴那几块），不先摊平就永远找不到
  if (Array.isArray(node)) {
    for (const child of node) findFirst(child, pred, out)
    return out
  }
  if (pred(node)) out.push(node)
  if (Array.isArray(node.children)) for (const c of node.children) findFirst(c, pred, out)
  return out
}

function render(props = {}) {
  React.__resetAll()
  const outer = registered.comp({ t: (k) => k, ...props })
  // 注册的组件返回 <Fragment><style/><TilesBoundary/></Fragment>：
  // expand() 只解函数/类节点，Fragment 是 symbol，所以要先把边界挑出来再展开
  const kids = Array.isArray(outer.children) ? outer.children : []
  const boundary = kids.find((k) => k && typeof k.type === 'function')
  ok(boundary !== undefined, '应当能从 Fragment 里找到错误边界')
  return expand(boundary)
}

/** 只重渲染、不重置 hooks —— 模拟 React 的 re-render（state 会留住） */
function rerender() {
  React.__begin()
  const outer = registered.comp({ t: (k) => k })
  const kids = Array.isArray(outer.children) ? outer.children : []
  const boundary = kids.find((k) => k && typeof k.type === 'function')
  ok(boundary !== undefined, '应当能找到错误边界')
  return expand(boundary)
}

/** 一颗方块：带 aria-pressed 的 button */
function tiles(tree) {
  return findFirst(tree, (n) => n.type === 'button' && n.props && n.props['aria-pressed'] !== undefined)
}

const SAMPLE = [
  { id: 'a', module: 'dsh-whale-desk', title: '小鲸鱼交互台', initial: '小', enabled: true, phase: 'active', readOnly: null, self: false },
  { id: 'b', module: 'dsh-lingxi-companion', title: '灵溪', initial: '灵', enabled: false, phase: null, readOnly: null, self: false },
  { id: 'c', module: 'dsh-plugin-tiles', title: '插件方块', initial: '插', enabled: true, phase: 'active', readOnly: null, self: true },
]

check('hook 数量在各帧一致（防 React #310）', () => {
  React.__resetAll()
  const counts = []
  for (let i = 0; i < 4; i += 1) {
    React.__begin()
    expand(registered.comp({ t: (k) => k, __testList: SAMPLE }))
    counts.push(React.__hooks())
    for (const fn of React.__effects()) {
      try {
        fn()
      } catch {
        /* effect 里可能有副作用失败，不影响计数判断 */
      }
    }
  }
  ok(
    counts.every((c) => c === counts[0]),
    `hook 数量不一致：${counts.join(', ')} —— 真机会抛 #310`,
  )
})

check('所有 hook 都在任何提前 return 之前', () => {
  const lines = source.split('\n')
  const start = lines.findIndex((l) => /function PluginTiles\(/.test(l))
  ok(start !== -1, '应当找到 PluginTiles')
  const isTopLevel = (line) => /^ {6}[^ ]/.test(line) || /^ {6}$/.test(line)
  let retAt = -1
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    const t = line.trim()
    if (t === '' || t.startsWith('//') || t.startsWith('*')) continue
    if (/^function [A-Z]/.test(t) || /^class /.test(t)) break
    if (isTopLevel(line) && /^return /.test(t)) {
      retAt = i
      break
    }
    if (isTopLevel(line) && /^if \(.*\) (return|\{)/.test(t) && t.includes('return')) {
      retAt = i
      break
    }
  }
  // glm 复核指出：匹配不到提前 return 时这条会静默按 pass 计。
  // 我们的源码里确实有一个 `if (list === null) return`，找不到就是扫描器失效，要报错。
  ok(retAt !== -1, '扫描器没找到提前 return —— 要么源码变了，要么正则失效，这条不能当通过')
  const bad = []
  for (let i = retAt + 1; i < lines.length; i += 1) {
    const t = lines[i].trim()
    if (t === '' || t.startsWith('//') || t.startsWith('*')) continue
    if (/^function [A-Z]/.test(t) || /^class /.test(t)) break
    if (isTopLevel(lines[i]) && /^(const\s+\w+\s*=\s*)?use(State|Effect|Ref|Callback|Memo|Reducer)\(/.test(t)) {
      bad.push(`L${i + 1}`)
    }
  }
  ok(bad.length === 0, `提前 return 之后还有 hook：${bad.join(', ')}`)
})

check('反证：hook 检测逻辑能抓到错位的 hook', () => {
  const fake = ['function Fake() {', '  const [a] = useState(0)', '  if (x) return null', '  useEffect(() => {}, [])', '}'].join('\n')
  const lines = fake.split('\n')
  const retAt = lines.findIndex((l) => /^\s*if \(.*\) return/.test(l))
  ok(retAt !== -1, '应当找到 return')
  let found = false
  for (let i = retAt + 1; i < lines.length; i += 1) {
    if (/^\s*use(State|Effect|Ref|Callback|Memo|Reducer)\(/.test(lines[i])) found = true
  }
  ok(found, '检测逻辑应能发现 return 后面的 hook')
})

check('还没读到列表时给省略号，不是空白', () => {
  const tree = render()
  const dots = findFirst(tree, (n) => n.type === 'span' && n.children && n.children[0] === '···')
  eq(dots.length, 1, '应当显示 ···')
})

/** 方块上那行字（名字 span 里的文本） */
function labelOf(tile) {
  const span = findFirst(tile, (n) => n.type === 'span')[0]
  return span ? String((span.children || []).join('')) : ''
}

check('列表来了就画方块：显示**整个名字**，不是首字', () => {
  const tree = render({ __testList: SAMPLE })
  const all = tiles(tree)
  eq(all.length, 3, '三块')
  // 2026-11-03 他问「怎么只能显示一个字符呢」→ 改成整名 + 省略号
  eq(all.map((b) => labelOf(b)), ['小鲸鱼交互台', '灵溪', '插件方块'], '方块上写全名')
  const span = findFirst(all[0], (n) => n.type === 'span')[0]
  eq(span.props.style.textOverflow, 'ellipsis', '放不下要省略，别溢出')
  eq(span.props.style.whiteSpace, 'nowrap', '不换行，否则方块会被撑高')
})

check('启用/停用分得开：深色键帽 vs 空心（角标已按他要求去掉）', () => {
  const tree = render({ __testList: SAMPLE })
  const all = tiles(tree)
  const on = all[0]
  const off = all[1]
  // 开：细描边 + **带渐变的深色键帽**（2026-11-03 他把黄色底换掉了）；关：虚线 + 空心 + 更暗
  ok(String(on.props.style.border).startsWith('1px solid'), `开应当是实线：${on.props.style.border}`)
  ok(String(off.props.style.border).startsWith('1px dashed'), `关应当是虚线：${off.props.style.border}`)
  ok(String(on.props.style.background).includes('linear-gradient'), `开应当是质感渐变：${on.props.style.background}`)
  ok(!String(on.props.style.background).includes('232,178,58'), '不该再用那块饱和琥珀色铺底')
  ok(String(on.props.style.boxShadow).includes('inset'), '开应当有内高光（键帽质感）')
  eq(off.props.style.background, 'transparent', '关应当是空心')
  eq(off.props.style.boxShadow, 'none', '关不该有高光')
  ok(on.props.style.opacity === 1, '开应当是满不透明')
  ok(off.props.style.opacity < 1, '关应当更暗')
  eq(on.props['aria-pressed'], true, '开关状态要进无障碍属性')
  eq(off.props['aria-pressed'], false, '关了就是 false')
  // 2026-11-03 他说「右下角的√可以去掉」——方块里只该有名字那一个 span，没有角标
  for (const tile of all) {
    const spans = findFirst(tile, (n) => n.type === 'span')
    eq(spans.length, 1, '方块里只该有那一个名字 span')
    ok(!['✓', '×'].includes(String(spans[0].children[0])), '不该再有 ✓/× 角标')
  }
})

check('title 里写清名字、包名、状态；自己的那块额外说明', () => {
  const tree = render({ __testList: SAMPLE })
  const all = tiles(tree)
  ok(String(all[0].props.title).includes('小鲸鱼交互台'), '要有名字')
  ok(String(all[0].props.title).includes('dsh-whale-desk'), '要有包名')
  // 注意：注册时的 t 会覆盖我传进去的那个桩，所以这里是真中文
  ok(String(all[1].props.title).includes('已停用'), `停用的要写「已停用」：${all[1].props.title}`)
  ok(String(all[2].props.title).includes('不能在这里关'), '自己那块要说明不能在这里关')
})

check('只读条目根本不显示（宿主滤过，客户端再兜一道）', () => {
  const tree = render({
    __testList: [
      { id: 'a', module: 'm-a', title: '能改的', initial: '能', enabled: true, phase: null, readOnly: null, self: false },
      { id: 'x', module: 'm-x', title: '改不了的', initial: '改', enabled: true, phase: null, readOnly: 'management-required', self: false },
    ],
  })
  const all = tiles(tree)
  eq(all.length, 1, '只留能改的那一块')
  eq(labelOf(all[0]), '能改的', '留下的应当是能改的那个')
  ok(
    findFirst(tree, (n) => n.props && String(n.props.title || '').includes('改不了的')).length === 0,
    '改不了的不该出现在任何地方',
  )
})

check('全都不改不了时说清原因，不是显示一个 0', () => {
  const tree = render({
    __testList: [
      { id: 'x', module: 'm-x', title: '改不了的', initial: '改', enabled: true, phase: null, readOnly: 'unaddressable', self: false },
    ],
  })
  eq(tiles(tree).length, 0, '没有方块')
  const hint = findFirst(tree, (n) => n.type === 'span' && String(n.children && n.children[0]).includes('没有可开关'))
  eq(hint.length, 1, '应当说明"没有可开关的插件"')
})

check('标题栏只摆 9 块，其余收进抽屉', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    id: `p${i}`,
    module: `m${i}`,
    title: `插件${i}`,
    initial: '插',
    enabled: i % 2 === 0,
    phase: null,
    readOnly: null,
    self: false,
  }))
  const tree = render({ __testList: many })
  const all = tiles(tree)
  eq(all.length, mod.__test.INLINE_TILES, `最多 ${mod.__test.INLINE_TILES} 块`)
  eq(mod.__test.INLINE_TILES, 9, '他定的是 9 个')
  const more = findFirst(tree, (n) => n.type === 'button' && n.props && n.props['data-more'] === '1')
  eq(more.length, 1, '应当有展开键（▾）')
  // 按钮上是三角（内联 SVG），不再显示条数 —— 2026-11-03 他问「这个 2 字是什么」，
  // 看不懂的数字就是噪声，条数挪进 title
  const glyph = more[0].children[0]
  eq(glyph && glyph.type, 'svg', '按钮里应当是一个 svg 三角')
  eq(String(more[0].children[0].children[0].children[0]).includes('▾'), false, '不该再有文字')
  ok(String(more[0].props.title).includes(String(20 - 9)), `条数要在 title 里：${more[0].props.title}`)
})

check('点 +N 打开抽屉：全部插件都列出来，一行一个', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    id: `p${i}`,
    module: `m${i}`,
    title: `插件${i}`,
    initial: '插',
    enabled: i % 2 === 0,
    phase: null,
    readOnly: null,
    self: false,
  }))
  const tree = render({ __testList: many })
  const more = findFirst(tree, (n) => n.type === 'button' && n.props && n.props['data-more'] === '1')
  eq(more.length, 1, '前提：有 +N')
  // 点开它 → 重渲染（不重置 hooks，state 留住）
  more[0].props.onClick()
  const opened = rerender()
  // 抽屉里的行：button + title 是模块名
  const drawerRows = findFirst(
    opened,
    (n) => n.type === 'button' && n.props && String(n.props.title || '').startsWith('m'),
  )
  eq(drawerRows.length, 20, '抽屉里应当是全部 20 个，不只是隐藏的那些')
  // 每行都有个勾选框
  const boxes = findFirst(opened, (n) => n.type === 'span' && n.props && n.props.style && n.props.style.width === 14)
  eq(boxes.length, 20, '每行一个勾选框')
})

check('点方块 = 真的发开关请求，且把状态取反', () => {
  const list = [
    { id: 'p0', module: 'm0', title: '插件0', initial: '插', enabled: true, phase: null, readOnly: null, self: false },
    { id: 'p1', module: 'm1', title: '插件1', initial: '插', enabled: true, phase: null, readOnly: null, self: false },
  ]
  const tree = render({ __testList: list })
  const inline = tiles(tree)
  eq(inline.length, 2, '两块都在标题栏（不足 9 个，不用抽屉）')
  fetchCalls.length = 0
  // toggle 是 async，但 fetch 在第一个 await 之前就被调用，所以这里同步断言得到
  inline[0].props.onClick()
  const posts = fetchCalls.filter((c) => c.opts && c.opts.method === 'POST')
  eq(posts.length, 1, '应当发一次 POST')
  eq(posts[0].url, '/.dsh-plugin-tiles/toggle', '地址')
  eq(JSON.parse(posts[0].opts.body), { id: 'p0', enabled: false }, '要把当前状态取反')
})

check('空列表时说清"没有装过第三方插件"，不是空白', () => {
  const tree = render({ __testList: [] })
  const hint = findFirst(tree, (n) => n.type === 'span' && String(n.children && n.children[0]).includes('插件开关'))
  eq(hint.length, 1, '应当给一句提示')
  eq(tiles(tree).length, 0, '不该有方块')
})

check('方块行不会把标题挤走：宽度有上限且可横向滚', () => {
  const tree = render({ __testList: SAMPLE })
  const row = findFirst(tree, (n) => n.props && n.props.className === 'dpt-row')
  eq(row.length, 1, '应当有行容器')
  ok(String(row[0].props.style.maxWidth).endsWith('vw'), '宽度上限用 vw')
  eq(row[0].props.style.overflowX, 'auto', '超出要能滚')
})

// 原来这两条是 `source.includes('class TilesBoundary')` 那种源码文本检查 ——
// glm 复核指出等于恒真（源码不变就永远过）。改成真调边界类。
check('错误边界：把错误装进 state，并把话画在屏幕上', () => {
  const B = mod.__test.TilesBoundary
  ok(typeof B === 'function', '应当导出边界类')
  const st = B.getDerivedStateFromError(new Error('boom: 渲染炸了'))
  ok(st !== null && st !== undefined && st.failure instanceof Error, 'getDerivedStateFromError 要把错误装进 state')

  const inst = new B({ t: (k) => k })
  inst.state = { failure: new Error('boom') }
  const out = inst.render()
  ok(out !== null && out !== undefined, '失败分支**不能**返回 null —— 那等于界面上什么都没有')
  eq(out.type, 'span', '应当是一行文字')
  ok(
    String((out.children || []).join('')).includes('渲染失败'),
    `要写清是渲染失败：${(out.children || []).join('')}`,
  )
  ok(String(out.props.title).includes('boom'), '完整错误要放进 title')
})

check('错误边界：没出错时渲染子组件，不吞掉', () => {
  const B = mod.__test.TilesBoundary
  const inst = new B({ t: (k) => k, __testList: SAMPLE })
  const out = inst.render()
  ok(out !== null && out !== undefined, '正常分支应当有输出')
  ok(typeof out.type === 'function', '应当返回组件节点（交给 React 继续展开）')
})

check('两套文案都有：中文与英文', () => {
  const zh = mod.__test.MESSAGES.zh
  const en = mod.__test.MESSAGES.en
  for (const key of Object.keys(zh)) ok(en[key] !== undefined, `en 缺 ${key}`)
  ok(typeof zh.label === 'string' && zh.label !== '', 'label')
  ok(typeof en.label === 'string' && en.label !== '', 'en label')
})

check('翻译器：认 zh 前缀，未知键原样返回', () => {
  const tZh = mod.__test.makeTranslator({ getSnapshot: () => ({ active: 'zh-CN' }) })
  eq(tZh('label'), mod.__test.MESSAGES.zh.label, '中文')
  const tEn = mod.__test.makeTranslator({ getSnapshot: () => ({ active: 'en-US' }) })
  eq(tEn('label'), mod.__test.MESSAGES.en.label, '英文')
  eq(tZh('no-such-key'), 'no-such-key', '未知键原样')
  const tNone = mod.__test.makeTranslator(undefined)
  eq(tNone('label'), mod.__test.MESSAGES.zh.label, '拿不到 locale 就用中文')
})

// ————————————————————————————————————————————————————————————
// 尺寸（2026-11-03 他要求「这些可以调整大小长短」）
// ————————————————————————————————————————————————————————————

check('尺寸收敛：坏值退回默认，超范围被夹住', () => {
  const { clampSize, clampWidth, SIZE_MIN, SIZE_MAX, WIDTH_MIN, WIDTH_MAX, TILE } = mod.__test
  eq(clampSize(undefined), TILE, '坏值退回默认')
  eq(clampSize('abc'), TILE, '非数字也退回默认')
  eq(clampSize(999), SIZE_MAX, '上限')
  eq(clampSize(1), SIZE_MIN, '下限')
  eq(clampSize(24.4), 24, '取整')
  eq(clampWidth(undefined, 30), 30, '没给宽就跟高一致')
  eq(clampWidth(999, 24), WIDTH_MAX, '宽上限')
  eq(clampWidth(-5, 24), WIDTH_MIN, '宽下限')
})

check('尺寸：默认 24×24', () => {
  win.localStorage.removeItem(mod.__test.LS_VIEW)
  const tree = render({ __testList: SAMPLE })
  const first = tiles(tree)[0]
  eq([first.props.style.width, first.props.style.height], [24, 24], '默认是正方形 24')
})

check('尺寸：存过的值要生效 —— 长短与大小是两个维度', () => {
  win.localStorage.setItem(mod.__test.LS_VIEW, JSON.stringify({ size: 40, width: 72 }))
  const tree = render({ __testList: SAMPLE })
  const first = tiles(tree)[0]
  eq(first.props.style.height, 40, '高 = 大小')
  eq(first.props.style.width, 72, '宽 = 长短')
  ok(first.props.style.fontSize >= 16, `字号要跟着放大：${first.props.style.fontSize}`)
  win.localStorage.removeItem(mod.__test.LS_VIEW)
})

check('尺寸：坏掉的本地存储不该炸界面', () => {
  win.localStorage.setItem(mod.__test.LS_VIEW, '{不是 JSON')
  eq(mod.__test.loadView(), { size: 24, width: 24 }, '退回默认')
  win.localStorage.removeItem(mod.__test.LS_VIEW)
  const tree = render({ __testList: SAMPLE })
  eq(tiles(tree).length, SAMPLE.length, '仍然能渲染')
})

function manyPlugins(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    module: `m${i}`,
    title: `插件${i}`,
    initial: '插',
    enabled: true,
    phase: null,
    readOnly: null,
    self: false,
  }))
}

check('抽屉里有两个滑块：大小 / 长短，值跟着当前尺寸', () => {
  win.localStorage.setItem(mod.__test.LS_VIEW, JSON.stringify({ size: 30, width: 44 }))
  const tree = render({ __testList: manyPlugins(12) })
  const more = findFirst(tree, (n) => n.type === 'button' && n.props && n.props['data-more'] === '1')
  eq(more.length, 1, '前提：有 +N')
  more[0].props.onClick()
  const opened = rerender()
  const ranges = findFirst(opened, (n) => n.type === 'input' && n.props.type === 'range')
  eq(ranges.length, 2, '两个滑块')
  const sizeRange = ranges.find((r) => r.props.min === mod.__test.SIZE_MIN)
  const widthRange = ranges.find((r) => r.props.min === mod.__test.WIDTH_MIN)
  ok(sizeRange !== undefined, '大小滑块要在（min = SIZE_MIN）')
  ok(widthRange !== undefined, '长短滑块要在（min = WIDTH_MIN）')
  eq(sizeRange.props.value, 30, '大小滑块反映当前值')
  eq(widthRange.props.value, 44, '长短滑块反映当前值')
  const nums = findFirst(opened, (n) => n.type === 'input' && n.props.type === 'number')
  ok(nums.some((n) => n.props.value === 30), '大小数字框')
  ok(nums.some((n) => n.props.value === 44), '长短数字框')
  win.localStorage.removeItem(mod.__test.LS_VIEW)
})

check('改大小会写进 localStorage（下次打开还是这个尺寸）', () => {
  win.localStorage.removeItem(mod.__test.LS_VIEW)
  const tree = render({ __testList: manyPlugins(12) })
  const more = findFirst(tree, (n) => n.type === 'button' && n.props && n.props['data-more'] === '1')
  more[0].props.onClick()
  const opened = rerender()
  const ranges = findFirst(opened, (n) => n.type === 'input' && n.props.type === 'range')
  const sizeRange = ranges.find((r) => r.props.min === mod.__test.SIZE_MIN)
  sizeRange.props.onChange({ target: { value: '36' } })
  const saved = JSON.parse(win.localStorage.getItem(mod.__test.LS_VIEW) || 'null')
  ok(saved !== null, '应当写进 localStorage')
  eq(saved.size, 36, '存的是新的大小')
  win.localStorage.removeItem(mod.__test.LS_VIEW)
})

check('拖宽度滑块 → 方块真的变宽（端到端，不只是"存的能渲染"）', () => {
  win.localStorage.removeItem(mod.__test.LS_VIEW)
  const tree = render({ __testList: manyPlugins(12) })
  const more = findFirst(tree, (n) => n.type === 'button' && n.props && n.props['data-more'] === '1')
  eq(more.length, 1, '前提：有 +N')
  more[0].props.onClick()
  const opened = rerender()
  const ranges = findFirst(opened, (n) => n.type === 'input' && n.props.type === 'range')
  const widthRange = ranges.find((r) => r.props.min === mod.__test.WIDTH_MIN)
  ok(widthRange !== undefined, '长短滑块要在')
  widthRange.props.onChange({ target: { value: '60' } })
  const after = rerender()
  const firstTile = tiles(after)[0]
  ok(firstTile !== undefined, '应当还有方块')
  eq(firstTile.props.style.width, 60, `方块宽应当变成 60，实际 ${firstTile.props.style.width}`)
  eq(firstTile.props.style.height, 24, '高不该被带着变')
  win.localStorage.removeItem(mod.__test.LS_VIEW)
})

check('拖大小滑块 → 变高；原来是正方形时宽跟着走', () => {
  win.localStorage.removeItem(mod.__test.LS_VIEW)
  const tree = render({ __testList: manyPlugins(12) })
  const more = findFirst(tree, (n) => n.type === 'button' && n.props && n.props['data-more'] === '1')
  more[0].props.onClick()
  const opened = rerender()
  const ranges = findFirst(opened, (n) => n.type === 'input' && n.props.type === 'range')
  const sizeRange = ranges.find((r) => r.props.min === mod.__test.SIZE_MIN)
  sizeRange.props.onChange({ target: { value: '36' } })
  const after = rerender()
  const firstTile = tiles(after)[0]
  eq(firstTile.props.style.height, 36, '高变成 36')
  eq(firstTile.props.style.width, 36, '原来是正方形，宽要跟着走')
  win.localStorage.removeItem(mod.__test.LS_VIEW)
})

check('Shift+滚轮：必须同时认 deltaX（Chromium 会把竖滚转成横滚）', () => {
  const d = mod.__test.pickWheelDelta
  eq(d({ deltaY: 100, deltaX: 0 }), 100, '普通滚轮读 deltaY')
  eq(d({ deltaY: 0, deltaX: 40 }), 40, 'Shift+滚轮只给 deltaX —— 这条最关键')
  eq(d({ deltaY: 0, deltaX: -40 }), -40, '方向要保留')
  eq(d({ deltaY: 3, deltaX: -40 }), -40, '两轴都有就取绝对值大的')
  eq(d({ deltaY: 0, deltaX: 0 }), 0, '都没有就返回 0（调用方据此 return）')
  eq(d(null), 0, '垃圾输入不炸')
})

check('抽屉的尺寸控件不许被长列表挤扁', () => {
  const tree = render({ __testList: manyPlugins(12) })
  const more = findFirst(tree, (n) => n.type === 'button' && n.props && n.props['data-more'] === '1')
  more[0].props.onClick()
  const opened = rerender()
  const controls = findFirst(
    opened,
    (n) => n.props && n.props.style && n.props.style.flexDirection === 'column' && n.props.style.padding === '7px 10px',
  )
  eq(controls.length, 1, '应当找到尺寸控件区')
  eq(controls[0].props.style.flex, '0 0 auto', '必须锁住，否则插件一多「长短」那行会被压没')
})

check('左键开关、右键改名：右键方块弹出改名卡', () => {
  const tree = render({ __testList: SAMPLE })
  const first = tiles(tree)[0]
  ok(typeof first.props.onContextMenu === 'function', '方块要挂 onContextMenu')
  ok(typeof first.props.onClick === 'function', '左键仍然只管开关')
  let prevented = false
  first.props.onContextMenu({
    clientX: 100,
    clientY: 100,
    preventDefault: () => {
      prevented = true
    },
  })
  ok(prevented, '要拦住浏览器默认右键菜单（否则会弹系统菜单）')
  const opened = rerender()
  const inputs = findFirst(opened, (n) => n.type === 'input' && n.props.type === 'text')
  eq(inputs.length, 1, '应当出现一个输入框')
  const labels = findFirst(opened, (n) => n.type === 'button')
    .map((b) => String((b.children || []).join('')))
    .join('|')
  ok(labels.includes('存'), `应当有「存」：${labels}`)
  ok(labels.includes('取消'), `应当有「取消」：${labels}`)
  // 抽屉里的行也要能右键改名（同一个手感）
  const rows = findFirst(opened, (n) => n.type === 'button' && typeof n.props.onContextMenu === 'function')
  ok(rows.length >= 1, '方块上要能右键')
})

check('右键改名：输入名字并保存，POST 带上模块名', () => {
  const tree = render({ __testList: SAMPLE })
  tiles(tree)[0].props.onContextMenu({ clientX: 10, clientY: 10, preventDefault() {} })
  const opened = rerender()
  const input = findFirst(opened, (n) => n.type === 'input' && n.props.type === 'text')[0]
  ok(input !== undefined, '应当有输入框')
  input.props.onChange({ target: { value: '阿鲸' } })
  const typed = rerender()
  fetchCalls.length = 0
  const save = findFirst(typed, (n) => n.type === 'button' && n.children && n.children[0] === '存')[0]
  ok(save !== undefined, '应当有「存」按钮')
  save.props.onClick()
  const posts = fetchCalls.filter((c) => c.opts && c.opts.method === 'POST')
  eq(posts.length, 1, '应当发一次 POST')
  eq(posts[0].url, '/.dsh-plugin-tiles/rename', '地址')
  eq(
    JSON.parse(posts[0].opts.body),
    { module: 'dsh-whale-desk', name: '阿鲸' },
    '要把模块名和新名字带上',
  )
})

check('抽屉里的行也能右键改名（不靠 ✎ 按钮了）', () => {
  win.localStorage.removeItem(mod.__test.LS_VIEW)
  const tree = render({ __testList: manyPlugins(12) })
  const more = findFirst(tree, (n) => n.type === 'button' && n.props && n.props['data-more'] === '1')
  more[0].props.onClick()
  const opened = rerender()
  // 抽屉行：title 是模块名、挂了 onContextMenu
  const rows = findFirst(opened, (n) => n.type === 'button' && String(n.props.title || '').startsWith('m'))
  eq(rows.length, 12, '12 行')
  for (const row of rows) ok(typeof row.props.onContextMenu === 'function', '每行都要能右键')
  // ✎ 按钮应当没有了
  const pencils = findFirst(opened, (n) => n.type === 'button' && n.children && n.children[0] === '✎')
  eq(pencils.length, 0, '不该再有 ✎ 按钮')
})

check('展开键和方块用同一套配色，且三角要够大够亮', () => {
  const tree = render({ __testList: SAMPLE })
  const tile = tiles(tree)[0] // 开着的方块
  const more = findFirst(tree, (n) => n.type === 'button' && n.props && n.props['data-more'] === '1')[0]
  ok(more !== undefined, '应当有展开键')
  // 2026-11-03 他说「这个图标也要和这些图标一样」——底色/边框/投影跟"开"的方块一致
  eq(more.props.style.background, tile.props.style.background, '底色要和方块一致')
  eq(more.props.style.border, tile.props.style.border, '边框要和方块一致')
  eq(more.props.style.boxShadow, tile.props.style.boxShadow, '投影要和方块一致')
  // 后来又说「白色也太小了」「三角起码要占到 70% 区域」——现在用 SVG 按百分比给尺寸，
  // 不依赖字体：换字号、换系统字体都不会缩水
  const svgNode = more.children && more.children[0]
  eq(svgNode && svgNode.type, 'svg', '三角要是 svg，不靠字体')
  eq(svgNode.props.width, '70%', '宽度占 70%')
  eq(svgNode.props.height, '70%', '高度占 70%')
  eq(svgNode.children[0].props.fill, '#ffffff', '纯白')
  eq(more.props['aria-label'] !== undefined, true, '要有无障碍标签')
})

check('展开键常驻：不足 9 个时也在（否则打不开抽屉里的尺寸控件）', () => {
  const tree = render({ __testList: SAMPLE }) // 只有 3 个
  const more = findFirst(tree, (n) => n.type === 'button' && n.props && n.props['data-more'] === '1')
  eq(more.length, 1, '只有 3 个插件时也要有 ▾')
  ok(String(more[0].props.title).length > 0, 'title 要给一句说明')
})

check('空列表也保留展开键，并给一句说明', () => {
  const tree = render({ __testList: [] })
  const more = findFirst(tree, (n) => n.type === 'button' && n.props && n.props['data-more'] === '1')
  eq(more.length, 1, '空列表也要能开抽屉（尺寸控件在里面）')
  const hint = findFirst(tree, (n) => n.type === 'span' && String(n.children && n.children[0]).includes('插件开关'))
  eq(hint.length, 1, '说明还在')
})

check('抽屉里有「全部静音」，点了发 POST /mute', () => {
  nextList = { ok: true, plugins: manyPlugins(3), mute: { active: false, count: 0 } }
  const tree = render({ __testList: manyPlugins(3) })
  const more = findFirst(tree, (n) => n.type === 'button' && n.props && n.props['data-more'] === '1')
  more[0].props.onClick()
  const opened = rerender()
  const muteBtn = findFirst(opened, (n) => n.type === 'button' && n.children && String(n.children[0] || '').includes('全部静音'))
  eq(muteBtn.length, 1, '应当有「全部静音」按钮')
  fetchCalls.length = 0
  muteBtn[0].props.onClick()
  const posts = fetchCalls.filter((c) => c.opts && c.opts.method === 'POST')
  eq(posts.length, 1, '应当发一次 POST')
  eq(posts[0].url, '/.dsh-plugin-tiles/mute', '地址')
})

check('已经静音时按钮变成「恢复 N 个」，点了发 POST /unmute', () => {
  nextList = { ok: true, plugins: manyPlugins(3) }
  const tree = render({ __testList: manyPlugins(3), __testMute: { active: true, count: 7 } })
  const more = findFirst(tree, (n) => n.type === 'button' && n.props && n.props['data-more'] === '1')
  more[0].props.onClick()
  const opened = rerender()
  const restore = findFirst(opened, (n) => n.type === 'button' && n.children && String(n.children[0] || '').includes('恢复'))
  eq(restore.length, 1, '应当有「恢复」按钮')
  ok(String(restore[0].children[0]).includes('7'), `文案要带条数：${restore[0].children[0]}`)
  fetchCalls.length = 0
  restore[0].props.onClick()
  const posts = fetchCalls.filter((c) => c.opts && c.opts.method === 'POST')
  eq(posts.length, 1, '应当发一次 POST')
  eq(posts[0].url, '/.dsh-plugin-tiles/unmute', '地址')
})

// ————————————————————————————————————————————————————————————

const total = pass + failures.length
if (failures.length === 0) {
  console.log(`OK ${pass}/${total}（插件方块 · 客户端，真渲染）`)
  process.exit(0)
}
console.log(`FAIL ${failures.length}/${total}`)
for (const f of failures) console.log(`  - ${f}`)
process.exit(1)
