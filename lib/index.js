/**
 * dsh-plugin-tiles —— 宿主半边。
 *
 * 干两件事：
 *   ① `GET  /.dsh-plugin-tiles/list`   —— 列出**装过的**插件（不含官方随包的那些）
 *   ② `POST /.dsh-plugin-tiles/toggle` —— 开关某一个
 *
 * 真正的动作在宿主的 `pluginManager` 服务上（`listPlugins` / `setPluginEnabled`），
 * 它同时也是 `plugin_manager` 工具背后的那个服务 —— 所以这里做出来的效果，
 * 和在「设置 → 插件」里点开关是**同一件事**，不是另搞一套状态。
 *
 * 为什么另开一个插件而不是塞进鲸鱼：
 *   方块本身就是"出事时用来救命"的入口。如果它长在某个插件里面，
 *   那个插件挂了 / 被关了，方块跟着一起没，等于把救命的钥匙锁在门后。
 */

import fs from 'node:fs'
import path from 'node:path'
import { openNames } from './names.js'
import { openMute } from './mute.js'

/** Plugin name registered with the Loader（照官方插件那套写的） */
export const name = 'plugin-tiles'

const ROUTE = '/.dsh-plugin-tiles'

/** 数据目录：`$DSH_HOME/plugin-tiles` —— 自定义名字放这里 */
function resolveDataDir() {
  const home =
    process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
  return path.join(home, 'plugin-tiles')
}

/**
 * 把自定义名字套上去（2026-11-03「我想自定义名字」）。
 * 改名之后方块上那个字也要跟着换，所以 `initial` 在这里重算 ——
 * normalizePlugin 里算的时候还不知道有没有自定义名。
 */
export function applyCustomNames(plugins, customNames) {
  const map = customNames && typeof customNames === 'object' ? customNames : {}
  const list = Array.isArray(plugins) ? plugins : []
  return list.map((item) => {
    const custom = map[item.module]
    if (typeof custom !== 'string' || custom === '') return { ...item, custom: false }
    return {
      ...item,
      title: custom,
      initial: Array.from(custom)[0] || item.initial,
      custom: true,
    }
  })
}

/** 自己的包名。用来认出"哪一块是我自己"，界面据此禁止自关。 */
const SELF_MODULE = 'dsh-plugin-tiles'

/** 列表缓存多久（毫秒）。切页签会连开好几次面板，别每次都问宿主。 */
const CACHE_MS = 4000

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

function sendJson(res, status, body) {
  try {
    res.writeHead(status, JSON_HEADERS)
    res.end(JSON.stringify(body))
  } catch {
    /* 客户端断了就断了 */
  }
}

/**
 * 信任栅栏：只认回环地址；带 Origin 的必须与 Host 同源。
 * 这条路由挂在真 HTTP 服务上，同网段理论上能访问到 —— 而它能开关插件，
 * 比便笺那种读写危险得多，栅栏不能省。
 *
 * ⚠️ Host / Origin 都是**请求方能自填**的，光看它们等于没栅栏：
 *    `curl -H 'Host: 127.0.0.1' http://192.168.1.9:PORT/...` 就直接过。
 *    2026-11-03 外部复核指出后补上 `req.socket.remoteAddress` ——
 *    这个字段由内核填，改不了。socket 缺失时（单测的假 req）放行，真服务里不会缺。
 */
function isLoopbackRequest(req) {
  const remote =
    req && req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : ''
  const remoteLocal =
    remote === '' ||
    remote === '127.0.0.1' ||
    remote === '::1' ||
    remote === '::ffff:127.0.0.1'
  if (!remoteLocal) return false
  const host = String(req.headers.host || '')
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  const local = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
  if (!local) return false
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== 'null') {
    try {
      if (new URL(origin).host !== host) return false
    } catch {
      return false
    }
  }
  return true
}

async function readJsonBody(req, limitBytes = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limitBytes) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('请求体必须是对象')
  }
  return parsed
}

/**
 * `PluginLocalizedMeta.title` 是 `string | {en, [locale]}`。
 * 中文优先，其次 en，实在没有就退回英文兜底 —— 界面上宁可显示包名，
 * 也不要显示 `[object Object]`。
 */
export function pickText(value, fallback) {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['zh', 'zh-CN', 'zh-Hans', 'en']) {
      const v = value[key]
      if (typeof v === 'string' && v.trim() !== '') return v.trim()
    }
    for (const v of Object.values(value)) {
      if (typeof v === 'string' && v.trim() !== '') return v.trim()
    }
  }
  const fb = typeof fallback === 'string' ? fallback.trim() : ''
  return fb === '' ? '插件' : fb
}

/**
 * 把宿主的一条 `PluginInfo` 压成界面要的形状。
 * 只留必要字段：这个对象会经 HTTP 出去、再进 React，塞整个 info 没必要。
 */
export function normalizePlugin(info, selfModule = SELF_MODULE) {
  const entryId = info && info.entryId !== undefined && info.entryId !== null ? String(info.entryId) : ''
  const moduleName = info && typeof info.moduleName === 'string' ? info.moduleName : ''
  const meta = info && info.meta && typeof info.meta === 'object' ? info.meta : null
  const title = pickText(meta && meta.title, moduleName || entryId)
  return {
    id: entryId,
    module: moduleName,
    title,
    // 一个字就够认了：方块只有 24px，两个字会挤
    initial: Array.from(title)[0] || '?',
    enabled: !!(info && info.enabled === true),
    phase: info && typeof info.fiberPhase === 'string' ? info.fiberPhase : null,
    readOnly: info && typeof info.readOnlyReason === 'string' ? info.readOnlyReason : null,
    self: moduleName === selfModule,
  }
}

/**
 * 「系统自带的」怎么认 —— 两次都判错过，所以把判据写在这里。
 *
 * ① 第一版按 `listBundles()` 里 `official === true` 的 `rows[].entryId` 滤：
 *    实测 `dsh-base` / `dsh-web-app` 的 `official` **是 false**，而
 *    `@deepseek-ai/dsh-experimental-agent-team-profile` 的才是 true —— 判据反了，
 *    一条都没滤掉，界面上冒出 `+186`。
 *
 * ② 第二版按模块名 `@deepseek-ai/` 前缀滤：能滤干净，但会**误杀**他自己装的
 *    官方插件（`@deepseek-ai/*` 也有能从市场装的）。
 *
 * 现在用的判据是 `BundleInfo.availability`：
 *   · `'installation'` —— 安装包自带（dsh-base / web-app / 各种官方实验 bundle）
 *   · `'profile'`      —— 装进 profile 的（他自己装的、手工挂的）
 * 只要某条目属于 installation 类 bundle 的 `rows[].entryId`，就当作"自带"。
 * 拿不到 bundle 信息时才退回模块名前缀 —— 那条虽然粗，但只在兜底时用。
 */
export const SHIPPED_MODULE_PREFIXES = ['@deepseek-ai/']
export const SHIPPED_MODULES = ['cordis:include']

export function isShippedModule(moduleName) {
  const m = typeof moduleName === 'string' ? moduleName.trim() : ''
  if (m === '') return true
  if (SHIPPED_MODULES.includes(m)) return true
  return SHIPPED_MODULE_PREFIXES.some((prefix) => m.startsWith(prefix))
}

/** 安装包自带的条目 id（`availability === 'installation'` 的 bundle 声明的行） */
export function shippedEntryIds(bundles) {
  const ids = new Set()
  for (const bundle of Array.isArray(bundles) ? bundles : []) {
    if (!bundle || bundle.availability !== 'installation') continue
    for (const row of Array.isArray(bundle.rows) ? bundle.rows : []) {
      if (row && row.entryId !== undefined && row.entryId !== null) ids.add(String(row.entryId))
    }
  }
  return ids
}

/** 老判据，留作兜底（bundle 数据拿不到时） */
export function officialEntryIds(bundles) {
  const ids = new Set()
  for (const bundle of Array.isArray(bundles) ? bundles : []) {
    if (!bundle || bundle.official !== true) continue
    for (const row of Array.isArray(bundle.rows) ? bundle.rows : []) {
      if (row && row.entryId !== undefined && row.entryId !== null) ids.add(String(row.entryId))
    }
  }
  return ids
}

/**
 * 一次拿全：只留他自己装的、**并且真能开关的**插件。
 *
 * 2026-11-03 他指着截图说「这种不可以修改的就不要显示吧」——
 * `readOnlyReason` 非空的条目点了也没用，直接不返回。
 * 排序按标题稳定排 —— **不按开关状态排**，点一下就重排会让人点到下一块。
 */
export function selectInstalled(plugins, bundles, selfModule = SELF_MODULE) {
  const all = Array.isArray(plugins) ? plugins : []
  const shipped = shippedEntryIds(bundles)
  const official = officialEntryIds(bundles)
  // bundle 数据可用就以它为准；拿不到才退回模块名前缀
  const useBundleRule = shipped.size > 0
  let skippedShipped = 0
  let skippedReadonly = 0
  const kept = []
  for (const info of all) {
    const item = normalizePlugin(info, selfModule)
    if (item.id === '') {
      skippedShipped += 1
      continue
    }
    const isShipped = useBundleRule ? shipped.has(item.id) || official.has(item.id) : isShippedModule(item.module)
    if (isShipped) {
      skippedShipped += 1
      continue
    }
    if (item.readOnly !== null) {
      skippedReadonly += 1
      continue
    }
    kept.push(item)
  }
  kept.sort((a, b) => {
    const x = String(a.title || '')
    const y = String(b.title || '')
    if (x === y) return String(a.id).localeCompare(String(b.id))
    return x.localeCompare(y, 'zh-Hans-CN')
  })
  return {
    plugins: kept,
    total: all.length,
    hidden: all.length - kept.length,
    skippedShipped,
    skippedReadonly,
  }
}

/** `ChangeResult` 只留界面用得上的字段 */
export function normalizeChange(result) {
  const r = result && typeof result === 'object' ? result : {}
  return {
    changed: r.changed === true,
    application: typeof r.application === 'string' ? r.application : 'unknown',
    restartReason: typeof r.restartReason === 'string' ? r.restartReason : null,
    enabled: typeof r.enabled === 'boolean' ? r.enabled : null,
    error:
      r.error && typeof r.error === 'object'
        ? {
            code: typeof r.error.code === 'string' ? r.error.code : 'unknown',
            diagnostic: typeof r.error.diagnostic === 'string' ? r.error.diagnostic : null,
          }
        : null,
    warnings: Array.isArray(r.warnings) ? r.warnings.filter((w) => typeof w === 'string') : [],
  }
}

export function apply(ctx) {
  const disposers = []
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        /* 拆卸失败不该妨碍其它清理 */
      }
    }
  })

  /**
   * `pluginManager` 是可选依赖：拿不到就如实回"不可用"，界面上显示原因。
   * 不能在这里抛错 —— 一个开关面板没接上，不该把整棵树拖塌。
   */
  let manager = null
  ctx.inject(['pluginManager'], (sub) => {
    const scope = sub ?? ctx
    const found =
      scope && scope.pluginManager !== undefined
        ? scope.pluginManager
        : typeof scope.get === 'function'
          ? scope.get('pluginManager')
          : undefined
    if (found) manager = found
  })

  // 列表缓存：只缓存**读**，开关/改名之后立刻作废，免得界面显示旧状态
  let cache = null
  const invalidate = () => {
    cache = null
  }

  /** 自定义名字（`$DSH_HOME/plugin-tiles/names.json`） */
  const customNames = openNames(resolveDataDir())
  /** 「全部静音」的账本（记住静音前开着哪些） */
  const muteBook = openMute(resolveDataDir())

  /**
   * 自己的 entryId。自关保护要用它，而**不能**依赖列表：
   * 列表读失败或缓存里恰好没有自己时，按"找不到就放行"写就是 fail-open
   * （glm 复核指出来的）。这里单独解析一次并记住，读不到就记为 null，由调用方拒绝。
   */
  let selfEntryId = null
  async function resolveSelfEntryId() {
    if (selfEntryId !== null) return selfEntryId
    if (!manager) return null
    try {
      const plugins = await manager.listPlugins()
      for (const info of Array.isArray(plugins) ? plugins : []) {
        if (info && String(info.moduleName || '') === SELF_MODULE) {
          const id = info.entryId !== undefined && info.entryId !== null ? String(info.entryId) : ''
          if (id !== '') {
            selfEntryId = id
            return id
          }
        }
      }
    } catch {
      return null
    }
    return null
  }

  async function loadList() {
    const now = Date.now()
    if (cache !== null && now - cache.at < CACHE_MS) return cache.value
    if (!manager) throw new Error('pluginManager 没就绪')
    const plugins = await manager.listPlugins()
    let bundles = []
    if (typeof manager.listBundles === 'function') {
      try {
        bundles = await manager.listBundles()
      } catch {
        // 拿不到 bundle 信息只是"没法按 installation 判据过滤"，会退回模块名前缀，
        // 不该让整个列表失败
        bundles = []
      }
    }
    // 顺手把自己的 entryId 记下来（列表里就有，不必再问一次）
    for (const info of Array.isArray(plugins) ? plugins : []) {
      if (info && String(info.moduleName || '') === SELF_MODULE) {
        const id = info.entryId !== undefined && info.entryId !== null ? String(info.entryId) : ''
        if (id !== '') selfEntryId = id
      }
    }
    const base = selectInstalled(plugins, bundles, SELF_MODULE)
    // 名字在过滤之后再套：过滤要靠模块名判"自带"，改名不能影响那个判断
    const value = { ...base, plugins: applyCustomNames(base.plugins, customNames.all()) }
    cache = { at: now, value }
    return value
  }

  /**
   * mute / unmute 串行化。
   *
   * 两者都是"逐个 await setPluginEnabled"，Node 单线程下 await 点会交错：
   * unmute 读到账本 → 并发进来的 mute 关了一批并写入新账本 → unmute 继续走到 clear()
   * → 结果是"插件关着、账本没了"，恢复名单永久丢失。
   * 客户端有 ref 挡双击，但服务端不能只靠客户端守。
   */
  let muteQueue = Promise.resolve()
  function serialize(task) {
    const run = muteQueue.then(task, task)
    muteQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  ctx.inject(['webServer'], (sub) => {    const webServer = sub ?? ctx
    const server = typeof webServer.get === 'function' ? webServer.get('webServer') : undefined
    if (!server || typeof server.register !== 'function') {
      console.warn('[plugin-tiles] 没有 webServer：开关面板没有数据来源')
      return
    }
    disposers.push(
      server.register({
        kind: 'prefix',
        path: ROUTE,
        handler: async (req, res) => {
          if (!isLoopbackRequest(req)) {
            sendJson(res, 403, { ok: false, error: 'forbidden' })
            return
          }
          const url = new URL(req.url || '/', 'http://localhost')
          const route = url.pathname
          const method = req.method || 'GET'
          try {
            if (route === `${ROUTE}/list` && method === 'GET') {
              if (!manager) {
                sendJson(res, 200, {
                  ok: false,
                  reason: 'no-plugin-manager',
                  plugins: [],
                  total: 0,
                  hidden: 0,
                  skippedShipped: 0,
                  skippedReadonly: 0,
                  serverNow: Date.now(),
                })
                return
              }
              const value = await loadList()
              sendJson(res, 200, {
                ok: true,
                ...value,
                self: SELF_MODULE,
                // 界面靠这个决定按钮上是「全部静音」还是「恢复 N 个」
                mute: (() => {
                  const m = muteBook.read()
                  return { active: m.active, count: m.ids.length }
                })(),
                serverNow: Date.now(),
              })
              return
            }

            if (route === `${ROUTE}/toggle` && method === 'POST') {
              const body = await readJsonBody(req)
              const id = typeof body.id === 'string' ? body.id.trim() : ''
              const enabled = body.enabled === true
              if (id === '') {
                sendJson(res, 400, { ok: false, error: '缺少 id' })
                return
              }
              if (!manager) {
                sendJson(res, 503, { ok: false, error: 'pluginManager 没就绪' })
                return
              }
              // 自己关自己 = 把钥匙锁在门后。要关它请走「设置 → 插件」。
              //
              // ⚠️ 这里必须 **fail-closed**：判定"这是不是我自己"失败时拒绝，而不是放行。
              //    上一版用 `loadList()` 找自己 —— 列表读抛错或缓存里没有自己时
              //    target 为 null，守卫直接放行，等于保护形同虚设（glm 复核指出）。
              if (enabled === false) {
                const self = await resolveSelfEntryId()
                if (self === null) {
                  sendJson(res, 503, {
                    ok: false,
                    error: 'self-check-unavailable',
                    detail: '没法确认这是不是开关面板自己，安全起见先拒绝。稍后再试，或改用「设置 → 插件」。',
                  })
                  return
                }
                if (self === id) {
                  sendJson(res, 400, {
                    ok: false,
                    error: 'self-disable-refused',
                    detail: '这是开关面板自己。关掉它，这些方块就没了 —— 请改用「设置 → 插件」。',
                  })
                  return
                }
              }
              const raw = await manager.setPluginEnabled(id, enabled)
              const result = normalizeChange(raw)
              invalidate()
              sendJson(res, 200, { ok: true, ...result, serverNow: Date.now() })
              return
            }

            // 自定义名字（2026-11-03「我想自定义名字」）
            // `{ module, name }`，name 为空 = 取消自定义，回到插件自己的标题
            if (route === `${ROUTE}/rename` && method === 'POST') {
              const body = await readJsonBody(req)
              const moduleName = typeof body.module === 'string' ? body.module : ''
              const next = customNames.set(moduleName, typeof body.name === 'string' ? body.name : '')
              invalidate()
              sendJson(res, 200, { ok: true, names: next, serverNow: Date.now() })
              return
            }

            /**
             * 全部静音 / 恢复（2026-11-03 他要的）。
             *
             * 只动"现在开着、且能开关、且不是我自己"的那些，关之前把 id 记下来；
             * 恢复时**只回填这份名单**，不去猜"应该开哪些"。
             * 逐个 await：并发打 setPluginEnabled 会让加载器同时改多行，容易互相踩。
             */
            if (route === `${ROUTE}/mute` && method === 'POST') {
              if (!manager) {
                sendJson(res, 503, { ok: false, error: 'pluginManager 没就绪' })
                return
              }
              const out = await serialize(async () => {
                // 已经静音过就别再覆盖 —— 再关一次会用"第二批"冲掉原名单，第一批永远回不来
                const existing = muteBook.read()
                if (existing.active) {
                  return {
                    status: 409,
                    body: {
                      ok: false,
                      error: 'already-muted',
                      detail: `之前静音的 ${existing.ids.length} 个还没恢复，先恢复再静音`,
                    },
                  }
                }
                // 静音是重操作，不省这一次读：先作废缓存，免得拿 4 秒前的状态做决定
                invalidate()
                const value = await loadList()
                const targets = value.plugins.filter((p) => p.enabled === true && p.self !== true)
                if (targets.length === 0) {
                  return {
                    status: 400,
                    body: { ok: false, error: 'nothing-to-mute', detail: '现在没有开着的插件可以静音' },
                  }
                }
                // **先落账本，再动手**：中途崩了/进程被杀，名单已经在盘上，
                // 至少还能恢复。反过来（先关后写）就等于把钥匙丢了。
                muteBook.write({ ids: targets.map((p) => p.id) })
                const ids = []
                const failed = []
                for (const item of targets) {
                  try {
                    const raw = await manager.setPluginEnabled(item.id, false)
                    const result = normalizeChange(raw)
                    if (result.application === 'failed') {
                      failed.push({ id: item.id, error: result.error ? String(result.error.code || 'failed') : 'failed' })
                    } else {
                      ids.push(item.id)
                    }
                  } catch (err) {
                    failed.push({ id: item.id, error: err && err.message ? err.message : String(err) })
                  }
                }
                // 关失败的那些不算"静音了"，从账本里剔掉，恢复时才不会去开它
                if (failed.length > 0) muteBook.write({ ids })
                if (ids.length === 0) muteBook.clear()
                invalidate()
                return {
                  status: 200,
                  body: {
                    ok: true,
                    muted: ids.length > 0,
                    count: ids.length,
                    failed,
                    // 大部分插件改完要重启才真的生效，界面要说清
                    application: 'restart-required',
                    serverNow: Date.now(),
                  },
                }
              })
              sendJson(res, out.status, out.body)
              return
            }

            if (route === `${ROUTE}/unmute` && method === 'POST') {
              if (!manager) {
                sendJson(res, 503, { ok: false, error: 'pluginManager 没就绪' })
                return
              }
              const out = await serialize(async () => {
                const saved = muteBook.read()
                if (!saved.active) {
                  return { status: 400, body: { ok: false, error: 'not-muted', detail: '之前没有静音过' } }
                }
                invalidate()
                const value = await loadList()
                // 名单里的插件可能已经被卸了/改了 id，也可能用户自己又开回来了：
                // 只回填"还存在的、且当前是关着的"，其余跳过
                const byId = new Map(value.plugins.map((p) => [p.id, p]))
                const restored = []
                const failed = []
                for (const id of saved.ids) {
                  const item = byId.get(id)
                  if (!item) continue
                  if (item.enabled === true) continue
                  try {
                    const raw = await manager.setPluginEnabled(id, true)
                    const result = normalizeChange(raw)
                    if (result.application === 'failed') failed.push({ id, error: 'failed' })
                    else restored.push(id)
                  } catch (err) {
                    failed.push({ id, error: err && err.message ? err.message : String(err) })
                  }
                }
                const missing = saved.ids.length - restored.length - failed.length
                // 一个都没恢复、而且确实有失败的 → **保留账本**，让他还能再点一次。
                // 只有"真恢复过"或"名单里的都不存在了"才清。
                if (restored.length === 0 && failed.length > 0) {
                  return {
                    status: 409,
                    body: {
                      ok: false,
                      error: 'restore-failed',
                      detail: `${failed.length} 个都恢复失败，名单保留着，可以再试一次`,
                      failed,
                      missing,
                      serverNow: Date.now(),
                    },
                  }
                }
                muteBook.clear()
                invalidate()
                return {
                  status: 200,
                  body: {
                    ok: true,
                    muted: false,
                    count: restored.length,
                    missing,
                    failed,
                    application: 'restart-required',
                    serverNow: Date.now(),
                  },
                }
              })
              sendJson(res, out.status, out.body)
              return
            }

            sendJson(res, 404, { ok: false, error: 'unknown route' })
          } catch (err) {
            const message = err && err.message ? err.message : String(err)
            // 判据是 store 挂的 `code: 'INVALID'`，不靠 message 猜 —— 那是"输入不对"（400），
            // 不是"服务出错"（500）。少了这条，缺 module 的改名会报成 500。
            const status = err && err.code === 'INVALID' ? 400 : 500
            if (status === 500) console.warn(`[plugin-tiles] ${method} ${route} 失败：${message}`)
            sendJson(res, status, { ok: false, error: message })
          }
        },
      }),
    )
  })
}
