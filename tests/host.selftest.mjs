/**
 * 宿主半边自检：真跑 apply，用假 ctx 抓住路由处理器，再喂假 req/res。
 *
 * 为什么这么测：`lib/index.js` 的本体就是那一个 handler，没有独立模块可以单测；
 * 不真跑一次，就只剩"看着像对的"。
 *
 * 跑法：node tests/host.selftest.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
// 自定义名字写在 `$DSH_HOME/plugin-tiles/names.json` —— 自检必须挪到临时目录，
// 绝不能碰他真实的那份（`~/.dsh/plugin-tiles`）。
// 必须在 apply() 之前设好：`resolveDataDir()` 是在 apply 里读的。
const DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tiles-host-'))
process.env.DSH_HOME = DSH_HOME
// Windows 上动态 import 绝对路径必须是 file:// URL，否则报 ERR_UNSUPPORTED_ESM_URL_SCHEME
const mod = await import(pathToFileURL(path.join(here, '..', 'lib', 'index.js')).href)
const {
  apply,
  pickText,
  normalizePlugin,
  officialEntryIds,
  shippedEntryIds,
  isShippedModule,
  selectInstalled,
  normalizeChange,
  applyCustomNames,
} = mod
import { openMute } from '../lib/mute.js'

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
async function checkAsync(name, fn) {
  try {
    await fn()
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
// 纯函数
// ————————————————————————————————————————————————————————————

check('pickText：串、本地化对象、英文兜底、什么都没有', () => {
  eq(pickText('小鲸鱼'), '小鲸鱼', '直接是串')
  eq(pickText({ zh: '小鲸鱼', en: 'Whale' }), '小鲸鱼', '中文优先')
  eq(pickText({ en: 'Whale' }), 'Whale', '只有 en')
  eq(pickText({ fr: 'Baleine' }), 'Baleine', '不认识的键就用第一个非空串')
  eq(pickText('   ', 'dsh-x'), 'dsh-x', '空白串要走兜底')
  eq(pickText(null, 'dsh-x'), 'dsh-x', 'null 走兜底')
  eq(pickText(undefined, ''), '插件', '连兜底都没有时给个能看的')
})

check('normalizePlugin：只留界面要的字段，并认出自己', () => {
  const item = normalizePlugin({
    entryId: 'abc',
    moduleName: 'dsh-plugin-tiles',
    meta: { title: { zh: '插件方块', en: 'Tiles' } },
    enabled: false,
    fiberPhase: 'active',
  })
  eq(item.id, 'abc', 'id')
  eq(item.title, '插件方块', '标题')
  eq(item.initial, '插', '方块上那个字')
  eq(item.enabled, false, 'enabled')
  eq(item.readOnly, null, '没有 readOnly')
  eq(item.self, true, '应当认出是自己')
  // 别人的条目不该被标成自己
  eq(normalizePlugin({ entryId: 'x', moduleName: 'other', meta: {} }).self, false, '别的不是自己')
})

check('normalizePlugin：没标题时退回包名，不显示 [object Object]', () => {
  const item = normalizePlugin({ entryId: 'e1', moduleName: 'dsh-lingxi-companion' })
  eq(item.title, 'dsh-lingxi-companion', '包名兜底')
  ok(!item.title.includes('object'), '不能漏出对象字面量')
  eq(item.initial, 'd', '第一个字母')
})

check('officialEntryIds：只认 official === true 的 bundle', () => {
  const ids = officialEntryIds([
    { official: true, rows: [{ entryId: 'a' }, { entryId: 'b' }, { entryId: undefined }] },
    { official: false, rows: [{ entryId: 'c' }] },
    { official: true, rows: [] },
    null,
  ])
  eq([...ids].sort(), ['a', 'b'], '只有官方 bundle 的行')
})

check('isShippedModule：认得出系统自带的', () => {
  // 2026-11-03 的教训：内核行是 `@deepseek-ai/...`，entryId 是 `include:*`
  ok(isShippedModule('@deepseek-ai/dsh-llm'), '官方包')
  ok(isShippedModule('@deepseek-ai/dsh-tools'), '官方包')
  ok(isShippedModule('cordis:include'), '加载器根')
  ok(isShippedModule(''), '空模块名也算（认不出来就别显示）')
  ok(!isShippedModule('dsh-whale-desk'), '他自己装的不该被滤')
  ok(!isShippedModule('dsh-wcdb'), '他自己装的不该被滤')
  ok(!isShippedModule('@venshell/dsh-workbuddy-connect'), '别的 scope 也不能误伤')
})

check('selectInstalled：改不了的（readOnly）直接不返回', () => {
  const plugins = [
    { entryId: 'p-1', moduleName: 'dsh-whale-desk', meta: { title: '鲸鱼' }, enabled: true },
    {
      entryId: 'p-2',
      moduleName: 'dsh-something',
      meta: { title: '改不了的' },
      enabled: false,
      readOnlyReason: 'management-required',
    },
    {
      entryId: 'p-3',
      moduleName: 'dsh-other',
      meta: { title: '也改不了' },
      enabled: true,
      readOnlyReason: 'unaddressable',
    },
  ]
  const out = selectInstalled(plugins, [], 'dsh-plugin-tiles')
  eq(out.plugins.map((p) => p.id), ['p-1'], '只留能开关的')
  eq(out.hidden, 2, '两条改不了的算进 hidden')
})

check('shippedEntryIds：按 availability === "installation" 认自带', () => {
  // 实测数据：dsh-base / dsh-web-app 的 official 是 **false**，但有 availability: 'installation'
  const ids = shippedEntryIds([
    { official: false, availability: 'installation', rows: [{ entryId: 'core-1' }, { entryId: 'core-2' }] },
    { official: true, availability: 'installation', rows: [{ entryId: 'exp-1' }] },
    { official: false, availability: 'profile', rows: [{ entryId: 'mine-1' }] },
    null,
  ])
  eq([...ids].sort(), ['core-1', 'core-2', 'exp-1'], '只认 installation 类的行')
  ok(!ids.has('mine-1'), 'profile 里装的不算自带')
})

check('selectInstalled：bundle 数据可用时，@deepseek-ai 的用户插件不该被误杀', () => {
  // glm 复核抓到的真实风险：他自己装的官方实验插件也是 @deepseek-ai/ 开头
  const plugins = [
    { entryId: 'core-1', moduleName: '@deepseek-ai/dsh-base-thing', meta: { title: '内核' } },
    { entryId: 'exp-1', moduleName: '@deepseek-ai/dsh-experimental-agent-team', meta: { title: '智能体团队' } },
  ]
  const bundles = [{ availability: 'installation', rows: [{ entryId: 'core-1' }] }]
  const out = selectInstalled(plugins, bundles, 'dsh-plugin-tiles')
  eq(out.plugins.map((p) => p.id), ['exp-1'], '自带的滤掉，用户装的官方插件要留住')
  eq(out.skippedShipped, 1, '自带计数')
})

check('selectInstalled：bundle 数据拿不到才退回模块名前缀兜底', () => {
  const plugins = [
    { entryId: 'core-1', moduleName: '@deepseek-ai/dsh-llm', meta: { title: '内核' } },
    { entryId: 'p-1', moduleName: 'dsh-wcdb', meta: { title: '微信库' } },
  ]
  const out = selectInstalled(plugins, [], 'dsh-plugin-tiles')
  eq(out.plugins.map((p) => p.id), ['p-1'], '兜底判据也要能滤干净')
})

check('selectInstalled：把「自带」和「只读」分开计数（文案要用）', () => {
  const plugins = [
    { entryId: 'core-1', moduleName: '@deepseek-ai/dsh-llm', meta: { title: '内核' } },
    { entryId: 'ro-1', moduleName: 'dsh-locked', meta: { title: '改不了' }, readOnlyReason: 'management-required' },
    { entryId: 'ok-1', moduleName: 'dsh-wcdb', meta: { title: '能改' } },
  ]
  const out = selectInstalled(plugins, [], 'dsh-plugin-tiles')
  eq(out.skippedShipped, 1, '自带 1 条')
  eq(out.skippedReadonly, 1, '只读 1 条')
  eq(out.hidden, 2, 'hidden 是两者之和')
  eq(out.plugins.length, 1, '只剩能改的那个')
})

check('selectInstalled：滤掉内核，保留他装的，按标题稳定排序', () => {
  const plugins = [
    { entryId: 'include:llm', moduleName: '@deepseek-ai/dsh-llm', meta: { title: 'LLM' }, enabled: true },
    { entryId: 'p-2', moduleName: 'dsh-wcdb', meta: { title: '微信库' }, enabled: false },
    { entryId: 'include', moduleName: 'cordis:include', enabled: true },
    { entryId: 'p-1', moduleName: 'dsh-whale-desk', meta: { title: '小鲸鱼交互台' }, enabled: true },
    { entryId: 'p-3', moduleName: 'dsh-plugin-tiles', meta: { title: '插件方块' }, enabled: true },
    { entryId: '', moduleName: 'dsh-broken' },
  ]
  const out = selectInstalled(plugins, [], 'dsh-plugin-tiles')
  // 中文按拼音：插(chā) < 灵(líng) < 小(xiǎo)
  eq(out.plugins.map((p) => p.id), ['p-3', 'p-2', 'p-1'], '内核与空 id 都滤掉，中文按拼音排')
  eq(out.total, 6, '总数算全部')
  eq(out.hidden, 3, '隐藏了三条（两个内核 + 空 id）')
  eq(out.plugins.find((p) => p.id === 'p-3').self, true, '自己那条要标出来')
})

check('selectInstalled：排序与开关状态无关（点一下不该跳位置）', () => {
  const base = { moduleName: 'dsh-a', meta: { title: '同一个' } }
  const on = selectInstalled([{ ...base, entryId: 'x', enabled: true }], [], 'x')
  const off = selectInstalled([{ ...base, entryId: 'x', enabled: false }], [], 'x')
  eq(on.plugins[0].id, off.plugins[0].id, '状态变了顺序不变')
})

check('selectInstalled：bundle 列表拿不到也不影响过滤（模块名那道就够）', () => {
  const plugins = [
    { entryId: 'a', moduleName: '@deepseek-ai/dsh-llm', meta: { title: '内核' } },
    { entryId: 'b', moduleName: 'dsh-wcdb', meta: { title: '微信库' } },
  ]
  const out = selectInstalled(plugins, null, 'dsh-plugin-tiles')
  eq(out.plugins.length, 1, '只留他装的那个')
  eq(out.plugins[0].id, 'b', 'id')
  eq(out.hidden, 1, '隐藏了一个')
})

check('normalizeChange：只留界面用得上、类型也对得上的字段', () => {
  eq(
    normalizeChange({ changed: true, application: 'restart-required', restartReason: 'no-hmr', enabled: false }),
    {
      changed: true,
      application: 'restart-required',
      restartReason: 'no-hmr',
      enabled: false,
      error: null,
      warnings: [],
    },
    '完整的一条',
  )
  const junk = normalizeChange(null)
  eq(junk.application, 'unknown', '垃圾输入也要有个合法 application')
  eq(junk.changed, false, 'changed 应当是 false')
})

// ————————————————————————————————————————————————————————————
// 路由
// ————————————————————————————————————————————————————————————

const ROUTE = '/.dsh-plugin-tiles'

function makeFakeManager(options = {}) {
  const calls = []
  const plugins = options.plugins || [
    { entryId: 'core-1', moduleName: '@deepseek-ai/dsh-base', meta: { title: '内核' }, enabled: true },
    { entryId: 'p-1', moduleName: 'dsh-whale-desk', meta: { title: { zh: '小鲸鱼交互台', en: 'Whale' } }, enabled: true },
    { entryId: 'p-2', moduleName: 'dsh-lingxi-companion', meta: { title: '灵溪' }, enabled: false },
    { entryId: 'p-3', moduleName: 'dsh-plugin-tiles', meta: { title: '插件方块' }, enabled: true },
  ]
  const bundles = options.bundles || [{ official: true, rows: [{ entryId: 'core-1' }] }]
  return {
    calls,
    async listPlugins() {
      return plugins
    },
    async listBundles() {
      if (options.bundlesThrows === true) throw new Error('catalog offline')
      return bundles
    },
    async setPluginEnabled(id, enabled) {
      calls.push({ id, enabled })
      // 真 manager 会改状态，假件也照做 —— 否则"只恢复当前关着的"这类逻辑测不出真假
      for (const item of plugins) {
        if (item.entryId === id) item.enabled = enabled === true
      }
      return { changed: true, application: 'applied', stage: 'enable', target: id, enabled }
    },
  }
}

function boot(options = {}) {
  let handler = null
  const manager = options.manager === undefined ? makeFakeManager(options) : options.manager
  const services = {
    webServer: {
      register(spec) {
        handler = spec.handler
        return () => {
          handler = null
        }
      },
    },
  }
  const ctx = {
    effect(fn) {
      fn()
    },
    inject(deps, cb) {
      if (deps.includes('pluginManager')) {
        // options.noManager = 模拟服务根本没装
        if (options.noManager === true) return
        const scope = { pluginManager: manager, get: (name) => (name === 'pluginManager' ? manager : undefined) }
        cb(scope)
        return
      }
      cb({ get: (name) => services[name] })
    },
    on() {},
    get(name) {
      return services[name]
    },
  }
  apply(ctx)
  ok(handler !== null, 'apply 应当注册了 webServer 路由')
  return { handler, manager }
}

const LOOPBACK = { host: '127.0.0.1:3083' }

function makeReq(method, pathname, body, headers) {
  const req = {
    method,
    url: `${ROUTE}${pathname}`,
    headers: headers === undefined ? { ...LOOPBACK } : headers,
  }
  if (body !== undefined) {
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    req[Symbol.asyncIterator] = async function* iterate() {
      yield payload
    }
  }
  return req
}

async function call(handler, method, pathname, body, headers, remoteAddress) {
  const out = { status: 0, body: '' }
  const res = {
    writeHead(status) {
      out.status = status
    },
    end(chunk) {
      out.body = String(chunk === undefined ? '' : chunk)
    },
  }
  const req = makeReq(method, pathname, body, headers)
  // 真服务里 socket 一定在；这里按需塞一个假 socket 来验"内网地址被拒"
  if (remoteAddress !== undefined) req.socket = { remoteAddress }
  await handler(req, res)
  let json = null
  try {
    json = JSON.parse(out.body)
  } catch {
    json = null
  }
  return { status: out.status, json }
}

await checkAsync('GET /list：只给装过的，按标题排序，并带 self 与 hidden', async () => {
  const { handler } = boot()
  const r = await call(handler, 'GET', '/list')
  eq(r.status, 200, 'status')
  eq(r.json.ok, true, 'ok')
  // 中文按拼音：插(p-3) < 灵(p-2) < 小(p-1)
  eq(r.json.plugins.map((p) => p.id), ['p-3', 'p-2', 'p-1'], '内核那条不该出现')
  eq(r.json.hidden, 1, '隐藏了一个（内核）')
  eq(r.json.self, 'dsh-plugin-tiles', '要告诉界面自己是谁')
  const tiles = r.json.plugins.find((p) => p.id === 'p-3')
  eq(tiles.self, true, '自己那条标 self')
  eq(r.json.plugins.find((p) => p.id === 'p-2').enabled, false, '停用状态要如实给')
})

await checkAsync('GET /list：listBundles 挂了也不该整个失败', async () => {
  const { handler } = boot({ bundlesThrows: true })
  const r = await call(handler, 'GET', '/list')
  eq(r.status, 200, 'status')
  eq(r.json.ok, true, 'ok')
  eq(r.json.plugins.length, 3, '模块名那道过滤仍然生效')
})

await checkAsync('GET /list：没有 pluginManager 时诚实回不可用，不是 500', async () => {
  const { handler } = boot({ noManager: true })
  const r = await call(handler, 'GET', '/list')
  eq(r.status, 200, 'status')
  eq(r.json.ok, false, 'ok 应当是 false')
  eq(r.json.reason, 'no-plugin-manager', '要说清原因')
  eq(r.json.plugins, [], '空列表')
})

await checkAsync('GET /list：缓存生效，连着问两次只读一次', async () => {
  const { handler, manager } = boot()
  let reads = 0
  const original = manager.listPlugins
  manager.listPlugins = async function counted() {
    reads += 1
    return original.call(this)
  }
  await call(handler, 'GET', '/list')
  await call(handler, 'GET', '/list')
  eq(reads, 1, '第二次应当命中缓存')
})

await checkAsync('POST /toggle：把开关交给 pluginManager，原样带回结果', async () => {
  const { handler, manager } = boot()
  const r = await call(handler, 'POST', '/toggle', { id: 'p-2', enabled: true })
  eq(r.status, 200, 'status')
  eq(r.json.ok, true, 'ok')
  eq(manager.calls, [{ id: 'p-2', enabled: true }], '要按原参数调服务')
  eq(r.json.application, 'applied', 'application 要透出来')
  eq(r.json.changed, true, 'changed 要透出来')
})

await checkAsync('POST /toggle：缺 id → 400', async () => {
  const { handler } = boot()
  for (const body of [{}, { id: '' }, { id: '   ' }, { id: 42 }]) {
    const r = await call(handler, 'POST', '/toggle', body)
    eq(r.status, 400, `应当 400（${JSON.stringify(body)}）`)
    eq(r.json.ok, false, 'ok')
  }
})

await checkAsync('POST /toggle：关自己 → 400，且真的没调服务', async () => {
  const { handler, manager } = boot()
  const r = await call(handler, 'POST', '/toggle', { id: 'p-3', enabled: false })
  eq(r.status, 400, 'status')
  eq(r.json.ok, false, 'ok')
  eq(r.json.error, 'self-disable-refused', '要说清是拒绝自关')
  eq(manager.calls, [], '一个调用都不该发出去')
})

await checkAsync('POST /toggle：判定不了"这是不是我"时**拒绝**，不是放行（fail-closed）', async () => {
  const manager = makeFakeManager()
  // 让"查自己"彻底失败：读列表直接抛
  manager.listPlugins = async () => {
    throw new Error('list broke')
  }
  const { handler } = boot({ manager })
  const r = await call(handler, 'POST', '/toggle', { id: 'p-1', enabled: false })
  eq(r.status, 503, 'status')
  eq(r.json.ok, false, 'ok')
  eq(r.json.error, 'self-check-unavailable', '要说清是没法确认')
  eq(manager.calls, [], '安全起见一个调用都不该发')
})

await checkAsync('POST /toggle：开自己是可以的（只是不许关）', async () => {
  const { handler, manager } = boot()
  const r = await call(handler, 'POST', '/toggle', { id: 'p-3', enabled: true })
  eq(r.status, 200, 'status')
  eq(manager.calls, [{ id: 'p-3', enabled: true }], '应当真的去开')
})

await checkAsync('POST /toggle：开关之后缓存要作废（列表不能显示旧状态）', async () => {
  const { handler, manager } = boot()
  await call(handler, 'GET', '/list')
  // 让服务在开关之后返回新状态
  manager.listPlugins = async () => [
    { entryId: 'p-1', moduleName: 'dsh-whale-desk', meta: { title: '鲸鱼' }, enabled: false },
  ]
  await call(handler, 'POST', '/toggle', { id: 'p-1', enabled: false })
  const after = await call(handler, 'GET', '/list')
  eq(after.json.plugins.length, 1, '应当读到新实现')
  eq(after.json.plugins[0].enabled, false, '状态要跟着变')
})

await checkAsync('POST /toggle：服务抛错 → 500 且带原因', async () => {
  const manager = makeFakeManager()
  manager.setPluginEnabled = async () => {
    throw new Error('pnpm exploded')
  }
  const { handler } = boot({ manager })
  const r = await call(handler, 'POST', '/toggle', { id: 'p-1', enabled: false })
  eq(r.status, 500, 'status')
  eq(r.json.ok, false, 'ok')
  ok(String(r.json.error).includes('pnpm exploded'), `要带原因：${r.json.error}`)
})

await checkAsync('信任栅栏：非回环 Host → 403', async () => {
  const { handler } = boot()
  const r = await call(handler, 'GET', '/list', undefined, { host: 'example.com' })
  eq(r.status, 403, 'status')
})

await checkAsync('信任栅栏：Origin 与 Host 不同源 → 403', async () => {
  const { handler } = boot()
  const r = await call(handler, 'GET', '/list', undefined, {
    host: '127.0.0.1:3083',
    origin: 'http://evil.example.com',
  })
  eq(r.status, 403, 'status')
})

await checkAsync('信任栅栏：同源 Origin 放行', async () => {
  const { handler } = boot()
  const r = await call(handler, 'GET', '/list', undefined, {
    host: '127.0.0.1:3083',
    origin: 'http://127.0.0.1:3083',
  })
  eq(r.status, 200, 'status')
})

await checkAsync('未知路由 → 404', async () => {
  const { handler } = boot()
  const r = await call(handler, 'GET', '/nope')
  eq(r.status, 404, 'status')
})

await checkAsync('POST /rename：存下名字，/list 立刻用上（缓存要作废）', async () => {
  const { handler } = boot()
  const before = await call(handler, 'GET', '/list')
  const target = before.json.plugins.find((p) => p.id === 'p-1')
  ok(target !== undefined, '前提：列表里有 p-1')

  const r = await call(handler, 'POST', '/rename', { module: 'dsh-whale-desk', name: '阿鲸' })
  eq(r.status, 200, 'status')
  eq(r.json.ok, true, 'ok')
  eq(r.json.names['dsh-whale-desk'], '阿鲸', '返回全量映射')

  const after = await call(handler, 'GET', '/list')
  const renamed = after.json.plugins.find((p) => p.id === 'p-1')
  eq(renamed.title, '阿鲸', '标题要换')
  eq(renamed.initial, '阿', '方块上的字也要换')
  eq(renamed.custom, true, '要标出自定义')
})

await checkAsync('POST /rename：空名字 = 取消自定义', async () => {
  const { handler } = boot()
  await call(handler, 'POST', '/rename', { module: 'dsh-whale-desk', name: '阿鲸' })
  const r = await call(handler, 'POST', '/rename', { module: 'dsh-whale-desk', name: '' })
  eq(r.status, 200, 'status')
  eq(r.json.names['dsh-whale-desk'], undefined, '键应当被删掉')
  const after = await call(handler, 'GET', '/list')
  eq(after.json.plugins.find((p) => p.id === 'p-1').title, '小鲸鱼交互台', '回到原名')
})

await checkAsync('POST /rename：缺 module → 400', async () => {
  const { handler } = boot()
  for (const body of [{}, { module: '' }, { module: '   ' }, { module: 42 }]) {
    const r = await call(handler, 'POST', '/rename', body)
    eq(r.status, 400, `应当 400（${JSON.stringify(body)}）`)
    eq(r.json.ok, false, 'ok')
  }
})

check('applyCustomNames：改名只影响显示，不动模块名', () => {
  const out = applyCustomNames([{ id: 'a', module: 'm', title: '原名', initial: '原' }], { m: '新名' })
  eq(out[0].module, 'm', '模块名不变（过滤还要靠它）')
  eq(out[0].title, '新名', '标题变')
})

// ————————————————————————————————————————————————————————————
// 全部静音 / 恢复
// ————————————————————————————————————————————————————————————

/**
 * 每个用例前清掉数据目录。
 * 静音账本落在 `$DSH_HOME/plugin-tiles/mute.json`，而所有用例共用同一个临时 HOME ——
 * 不清的话前一个用例的"已静音"会漏到下一个（第一版就是这么红的）。
 */
function clearData() {
  fs.rmSync(path.join(DSH_HOME, 'plugin-tiles'), { recursive: true, force: true })
}

await checkAsync('POST /mute：关掉所有开着的（不含自己），并把名单记下来', async () => {
  clearData()
  const manager = makeFakeManager()
  const { handler } = boot({ manager })
  const r = await call(handler, 'POST', '/mute')
  eq(r.status, 200, 'status')
  eq(r.json.ok, true, 'ok')
  eq(r.json.muted, true, '状态')
  eq(r.json.application, 'restart-required', '要提醒重启')
  // p-1、p-3 开着；p-3 是它自己，不许关；p-2 本来就关着，不用动
  const disabled = manager.calls.filter((c) => c.enabled === false).map((c) => c.id)
  eq(disabled, ['p-1'], '只关该关的')
  ok(!disabled.includes('p-3'), '绝不能把自己关掉')
  eq(r.json.count, 1, '计数')
})

await checkAsync('POST /mute 之后 /list 会报 muted，恢复后回填同样的那一批', async () => {
  clearData()
  const manager = makeFakeManager()
  const { handler } = boot({ manager })
  const before = await call(handler, 'GET', '/list')
  eq(before.json.mute.active, false, '一开始没静音')

  await call(handler, 'POST', '/mute')
  const muted = await call(handler, 'GET', '/list')
  eq(muted.json.mute.active, true, '静音之后')
  eq(muted.json.mute.count, 1, '名单里 1 个')

  manager.calls.length = 0
  const back = await call(handler, 'POST', '/unmute')
  eq(back.status, 200, 'status')
  eq(back.json.muted, false, '状态')
  eq(manager.calls, [{ id: 'p-1', enabled: true }], '只把名单里那个开回来')

  const after = await call(handler, 'GET', '/list')
  eq(after.json.mute.active, false, '恢复之后不再显示静音')
})

await checkAsync('POST /unmute：没静音过 → 400，不瞎开别人的插件', async () => {
  clearData()
  const manager = makeFakeManager()
  const { handler } = boot({ manager })
  const r = await call(handler, 'POST', '/unmute')
  eq(r.status, 400, 'status')
  eq(r.json.error, 'not-muted', '要说清原因')
  eq(manager.calls, [], '一个都不许动')
})

await checkAsync('POST /mute：一个都没开着 → 400，不写空账本', async () => {
  clearData()
  const manager = makeFakeManager({
    plugins: [
      { entryId: 'p-1', moduleName: 'dsh-a', meta: { title: 'A' }, enabled: false },
      { entryId: 'p-3', moduleName: 'dsh-plugin-tiles', meta: { title: '插件方块' }, enabled: true },
    ],
  })
  const { handler } = boot({ manager })
  const r = await call(handler, 'POST', '/mute')
  eq(r.status, 400, 'status')
  eq(r.json.error, 'nothing-to-mute', '原因')
  eq(manager.calls, [], '自己那块也不许动')
})

await checkAsync('POST /unmute：名单里的插件已经被卸载 → 跳过，不报错也不卡住', async () => {
  clearData()
  const manager = makeFakeManager()
  const { handler } = boot({ manager })
  await call(handler, 'POST', '/mute')
  // 模拟 p-1 被卸掉了
  manager.listPlugins = async () => [
    { entryId: 'p-2', moduleName: 'dsh-lingxi-companion', meta: { title: '灵溪' }, enabled: false },
    { entryId: 'p-3', moduleName: 'dsh-plugin-tiles', meta: { title: '插件方块' }, enabled: true },
  ]
  manager.calls.length = 0
  const r = await call(handler, 'POST', '/unmute')
  eq(r.status, 200, 'status')
  eq(r.json.count, 0, '没有能恢复的')
  eq(r.json.missing, 1, '要报出跳过了几个')
  eq(manager.calls, [], '不存在的 id 不去调')
  const after = await call(handler, 'GET', '/list')
  eq(after.json.mute.active, false, '账本要清掉，不能卡在恢复不了的状态')
})

check('mute 账本：坏文件当没静音；空名单也不许卡住', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiles-mute-'))
  try {
    fs.writeFileSync(path.join(dir, 'mute.json'), '{坏 JSON', 'utf8')
    eq(openMute(dir).read(), { active: false, ids: [] }, '坏 JSON')
    fs.writeFileSync(path.join(dir, 'mute.json'), JSON.stringify({ active: true, ids: [] }), 'utf8')
    eq(openMute(dir).read(), { active: false, ids: [] }, 'active 但没名单 = 没静音')
    const book = openMute(dir)
    book.write({ ids: ['a', 'a', ' b ', '', null, 3] })
    eq(book.read().ids, ['a', 'b'], '去重、去空白、丢非字符串')
    book.clear()
    eq(book.read(), { active: false, ids: [] }, '清掉之后')
    book.clear() // 再清一次不该抛
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

check('信任栅栏：内网来的请求直接 403，哪怕 Host 伪造成 127.0.0.1', async () => {
  const { handler } = boot()
  // Host 头是请求方能自填的，光看它等于没栅栏 —— 内核填的 remoteAddress 才是硬证据
  const r = await call(handler, 'POST', '/mute', {}, { host: '127.0.0.1:13696' }, '192.168.1.9')
  eq(r.status, 403, 'status')
  eq(r.json.ok, false, 'ok')
  // 回环地址照常放行（这里用 403 判定，说明前面的栅栏过了）
  const okLocal = await call(handler, 'POST', '/mute', {}, { host: '127.0.0.1:13696' }, '::1')
  ok(okLocal.status !== 403, `回环不该被拦：${okLocal.status}`)
})

await checkAsync('POST /mute：已经静音过 → 409，且**不覆盖**原名单', async () => {
  clearData()
  const manager = makeFakeManager()
  const { handler } = boot({ manager })
  const first = await call(handler, 'POST', '/mute')
  eq(first.json.count, 1, '第一次静音 1 个')
  const book = openMute(path.join(DSH_HOME, 'plugin-tiles'))
  const savedIds = book.read().ids
  // 期间用户自己开了别的插件，再点一次静音
  manager.calls.length = 0
  const second = await call(handler, 'POST', '/mute')
  eq(second.status, 409, 'status')
  eq(second.json.error, 'already-muted', '原因')
  eq(manager.calls, [], '不许再动插件')
  eq(book.read().ids, savedIds, '原名单必须原样保留')
})

await checkAsync('POST /mute：部分失败 → 失败的不进账本，免得恢复时去开它', async () => {
  clearData()
  const manager = makeFakeManager()
  manager.setPluginEnabled = async (id, enabled) => {
    manager.calls.push({ id, enabled })
    if (id === 'p-1') throw new Error('store locked')
    for (const item of manager.plugins || []) if (item.entryId === id) item.enabled = enabled === true
    return { changed: true, application: 'applied', target: id, enabled }
  }
  const { handler } = boot({ manager })
  const r = await call(handler, 'POST', '/mute')
  eq(r.status, 200, 'status')
  eq(r.json.count, 0, '一个都没关成')
  eq(r.json.failed.length, 1, '要报出失败的')
  eq(r.json.failed[0].id, 'p-1', '失败的是哪个')
  const book = openMute(path.join(DSH_HOME, 'plugin-tiles'))
  eq(book.read().active, false, '全失败就不该留下"已静音"的假状态')
})

await checkAsync('POST /unmute：全部恢复失败 → 409，账本保留，还能再试', async () => {
  clearData()
  const manager = makeFakeManager()
  const { handler } = boot({ manager })
  await call(handler, 'POST', '/mute')
  manager.setPluginEnabled = async () => {
    throw new Error('store locked')
  }
  const r = await call(handler, 'POST', '/unmute')
  eq(r.status, 409, 'status')
  eq(r.json.error, 'restore-failed', '原因')
  const book = openMute(path.join(DSH_HOME, 'plugin-tiles'))
  eq(book.read().active, true, '账本必须还在')
  eq(book.read().ids, ['p-1'], '名单不能被清')
})

check('mute 账本：写的时候先落 .tmp 再 rename（不留半截 JSON）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiles-mute-atomic-'))
  try {
    const book = openMute(dir)
    book.write({ ids: ['x'] })
    eq(book.read().ids, ['x'], '读得回来')
    const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))
    eq(leftovers, [], '不该留下临时文件')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ————————————————————————————————————————————————————————————

fs.rmSync(DSH_HOME, { recursive: true, force: true })

const total = pass + failures.length
if (failures.length === 0) {
  console.log(`OK ${pass}/${total}（插件方块 · 宿主）`)
  process.exit(0)
}
console.log(`FAIL ${failures.length}/${total}`)
for (const f of failures) console.log(`  - ${f}`)
process.exit(1)
