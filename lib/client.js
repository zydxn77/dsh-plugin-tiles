/**
 * dsh-plugin-tiles —— 客户端半边。
 *
 * 在会话标题那一排（`conversation.session.header.actions`，也就是"创造模式 /
 * 子智能体"所在的位置）挂一排小方块：一个小方块 = 一个装过的插件。
 * 亮着的表示启用，暗的表示停用；点一下翻转。
 *
 * ⚠️ 形状照抄已在跑的插件，不照文档猜：
 *    window.__ModuleLoader__.load({ id, factory })，只 require('react')。
 * ⚠️ 所有 hook 必须在任何提前 return **之前**（React #310 那个坑）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-tiles',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    /** 与 lib/index.js 的 ROUTE 必须一致 */
    const ROUTE = '/.dsh-plugin-tiles'
    /** 挂哪儿：标题旁那一排动作 */
    const SLOT = 'conversation.session.header.actions'
    const PREFIX = 'dpt-'
    /** 多久刷一次。插件也可能在「设置 → 插件」里被改，别只信点出来的结果 */
    const POLL_MS = 20_000
    /** 标题栏里最多摆几块。2026-11-03 他定：9 个，其余进抽屉 */
    const INLINE_TILES = 9
    /** 滚轮调尺寸的节流（ms）。事件密度能到 100Hz，每帧 setState 是浪费 */
    const WHEEL_THROTTLE_MS = 30
    /** 默认方块高（px）。真正的值在 `view.size`，这个是出厂值 */
    const TILE = 24

    /**
     * 方块尺寸（2026-11-03 他说「这些可以调整大小长短」）。
     *
     * 两个维度分开调：
     *   · `size`  —— 高，也决定字号与圆角（"大小"）
     *   · `width` —— 宽（"长短"），默认跟高一致就是正方形
     * 存在 localStorage（纯观感，不进宿主存储），换机器重设也无所谓。
     */
    const LS_VIEW = 'dsh-plugin-tiles:view'
    const SIZE_MIN = 14
    const SIZE_MAX = 44
    const WIDTH_MIN = 12
    const WIDTH_MAX = 96

    /**
     * 尺寸收敛到合法范围。坏值退回默认，别让界面炸成 0 宽。
     * ⚠️ `null` / `''` 要当"没给"处理：`Number(null)` 是 0，会被夹到最小值，
     *    于是"默认 24"变成"最小 14"——这个坑是被自检抓出来的。
     */
    function clampSize(input) {
      if (input === null || input === undefined || input === '') return TILE
      const n = Number(input)
      if (!Number.isFinite(n)) return TILE
      return Math.round(Math.min(SIZE_MAX, Math.max(SIZE_MIN, n)))
    }

    function clampWidth(input, size) {
      const base = clampSize(size)
      if (input === null || input === undefined || input === '') return base
      const n = Number(input)
      if (!Number.isFinite(n)) return base
      return Math.round(Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, n)))
    }

    /** 读上次的尺寸。坏 JSON / 缺字段都退回默认，不报错 */
    function loadView() {
      let raw = null
      try {
        raw = window.localStorage.getItem(LS_VIEW)
      } catch {
        raw = null
      }
      let parsed = null
      try {
        parsed = raw ? JSON.parse(raw) : null
      } catch {
        parsed = null
      }
      const size = clampSize(parsed && parsed.size)
      return { size, width: clampWidth(parsed && parsed.width, size) }
    }

    /**
     * 方块"开"状态的配色（2026-11-03 他说「黄色背景换个高级点的」）。
     *
     * 换掉了原来那块饱和琥珀色（`rgb(232,178,58)` 实心填充）——它显眼但廉价。
     * 现在做成**键帽**质感：深石墨竖向渐变 + 上沿一道内高光 + 细描边 + 极浅投影。
     * 三个好处：
     *   · 不跟主题抢色（深浅主题下都立得住，因为它自带边界）；
     *   · 有"按下去是实体键"的暗示，比一块纯色更有质感；
     *   · 暖色只留在极细的描边上做点缀，不再大面积铺开。
     *
     * 改这里就能换配色，别在 JSX 里再散写颜色。
     */
    const TILE_ON = {
      background: 'linear-gradient(180deg, #3a4150 0%, #262c38 100%)',
      border: '1px solid rgba(255,255,255,.16)',
      color: '#f5f1e8',
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,.14), 0 1px 2px rgba(0,0,0,.28)',
    }
    /** "关"状态：空心 + 虚线，保持和原来一样的克制 */
    const TILE_OFF = {
      background: 'transparent',
      border: '1px dashed var(--dsw-alias-border-l2)',
      color: 'var(--dsw-alias-label-secondary)',
      boxShadow: 'none',
    }

    /**
     * 滚轮事件的"有效方向"。
     *
     * ⚠️ `Shift+滚轮` 在 Chromium 里会把纵向滚动**转成 `deltaX`、`deltaY=0`**。
     *    只看 deltaY 的话这个手势永远返回 0、什么都不发生 ——
     *    2026-11-03 他就是这么撞上"放大可以、改宽度不行"的。
     * 抽成纯函数是为了能测：两个轴都读，取绝对值大的那个。
     */
    function pickWheelDelta(event) {
      const dy = Number(event && event.deltaY) || 0
      const dx = Number(event && event.deltaX) || 0
      return Math.abs(dy) >= Math.abs(dx) ? dy : dx
    }

    function saveView(view) {
      try {
        window.localStorage.setItem(LS_VIEW, JSON.stringify({ size: view.size, width: view.width }))
      } catch {
        /* 存不进去不影响这一屏 */
      }
    }

    const MESSAGES = {
      zh: {
        label: '插件开关',
        on: '已启用',
        off: '已停用',
        readonly: '这个条目改不了',
        selfTag: '（就是这排方块自己，不能在这里关）',
        loading: '正在读插件列表…',
        empty: '没有装过第三方插件',
        failed: '读不到插件列表',
        restart: '已改，重启 DSH 后生效',
        applied: '已生效',
        refused: '关不了',
        more: '还有 {n} 个，点开抽屉',
        readonlyShort: '只读',
        close: '关掉抽屉',
        noToggleable: '没有可开关的插件（其余要在设置里改）',
        notReady: '插件管理服务还没就绪',
        drawerEmpty: '这里没有可开关的',
        tileSize: '大小',
        tileWidth: '长短',
        resetSize: '复位',
        sizeHint: '也可以把鼠标放在方块上：滚轮调大小，Shift+滚轮调长短',
        rename: '改名字',
        renameHint: '给自己起个名字，只影响这里显示，不改插件本身',
        openDrawer: '展开抽屉',
        saveName: '存',
        cancelName: '取消',
        namePlaceholder: '名字（留空 = 用原名）',
      },
      en: {
        label: 'Plugin switches',
        on: 'enabled',
        off: 'disabled',
        readonly: 'this entry cannot be changed',
        selfTag: '(this tile row itself — cannot be turned off here)',
        loading: 'reading plugins…',
        empty: 'no third-party plugins installed',
        failed: 'cannot read the plugin list',
        restart: 'changed, takes effect after restarting DSH',
        applied: 'applied',
        refused: 'cannot turn off',
        more: '{n} more — open the drawer',
        readonlyShort: 'read-only',
        close: 'close the drawer',
        noToggleable: 'nothing here is switchable (use Settings)',
        notReady: 'the plugin manager is not ready yet',
        drawerEmpty: 'nothing switchable here',
        tileSize: 'Size',
        tileWidth: 'Length',
        resetSize: 'Reset',
        sizeHint: 'or hover the tiles: wheel = size, Shift+wheel = length',
        rename: 'Rename',
        renameHint: 'a display name just for this row; the plugin itself is unchanged',
        openDrawer: 'Open the drawer',
        saveName: 'Save',
        cancelName: 'Cancel',
        namePlaceholder: 'name (empty = original)',
      },
    }

    function makeTranslator(locale) {
      let active = 'zh'
      try {
        const snap = locale && typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : null
        if (snap && typeof snap.active === 'string') active = snap.active
      } catch {
        /* 拿不到就用中文 */
      }
      const dict = String(active).toLowerCase().startsWith('zh') ? MESSAGES.zh : MESSAGES.en
      return (key, vars) => {
        const raw = dict[key] !== undefined ? dict[key] : MESSAGES.zh[key] !== undefined ? MESSAGES.zh[key] : key
        if (!vars) return raw
        return raw.replace(/\{(\w+)\}/g, (m, name) => (vars[name] === undefined ? m : String(vars[name])))
      }
    }

    // ——————————————————————————————————————————————————————————————
    // 组件
    // ——————————————————————————————————————————————————————————————
    function PluginTiles(props) {
      const t = props.t
      /**
       * null = 还没读到；[] = 读到了但一个都没有。
       * `__testList` 只在自检沙箱里生效（`window.__DESK_TEST__ === true` 且调用方塞了它）：
       * 单测里没有 fetch 的时序，不塞种子就永远停在 null，那 100 多行渲染等于没测。
       * 生产环境走不到这个分支（slot 传下来的 props 里没有这个字段）。
       */
      const [list, setList] = useState(() => {
        const seeded =
          typeof window !== 'undefined' && window.__DESK_TEST__ === true ? props.__testList : undefined
        return Array.isArray(seeded) ? seeded : null
      })
      const [notice, setNotice] = useState(null)
      const [failure, setFailure] = useState('')
      const [busyId, setBusyId] = useState('')
      /** 宿主报的统计：自带几条 / 只读几条。文案要据此区分"没有"和"都不能改" */
      const [stats, setStats] = useState(null)
      /** 抽屉：null = 关着；否则是它的固定定位坐标（由触发按钮的 rect 算出来） */
      const [drawer, setDrawer] = useState(null)
      /**
       * 改名卡：null = 关着。
       * 形状 `{ module, title, top, left }` —— 坐标由右键的 clientX/clientY 算出来。
       * 2026-11-03 他定：**左键开关、右键改名**，所以方块和抽屉行都挂 onContextMenu。
       */
      const [rename, setRename] = useState(null)
      const [nameDraft, setNameDraft] = useState('')
      const aliveRef = useRef(true)
      const noticeTimerRef = useRef(null)
      const moreBtnRef = useRef(null)
      const rowRef = useRef(null)
      /** 方块尺寸：{ size, width }，见文件头 LS_VIEW 那一段 */
      const [view, setView] = useState(loadView)
      const viewRef = useRef(view)
      /**
       * 正在请求的 id。state 之外再放一份 ref：
       * 双击同一块时两次 click 拿到的是同一帧的 `busyId`（state 要下一次渲染才变），
       * 光靠 state 拦不住，会发两个 POST（glm 复核指出的竞态）。
       */
      const busyRef = useRef('')

      /** 一闪而过的说明（重启才生效 / 关不了 之类）。不清掉会一直挂着。 */
      const flash = useCallback((text) => {
        setNotice({ text, at: Date.now() })
        if (noticeTimerRef.current !== null) {
          clearTimeout(noticeTimerRef.current)
        }
        noticeTimerRef.current = setTimeout(() => {
          noticeTimerRef.current = null
          setNotice(null)
        }, 4000)
      }, [])

      const refresh = useCallback(async () => {
        try {
          const res = await fetch(`${ROUTE}/list`, { cache: 'no-store' })
          const data = await res.json().catch(() => null)
          if (!res.ok || !data || typeof data !== 'object') throw new Error(`HTTP ${res.status}`)
          if (!aliveRef.current) return
          if (data.ok === false) {
            // 「服务没就绪」和「读不到」是两件事，文案要分开
            setFailure(data.reason === 'no-plugin-manager' ? t('notReady') : t('failed'))
            setList([])
            setStats(null)
            return
          }
          setFailure('')
          setStats({
            total: Number(data.total) || 0,
            skippedShipped: Number(data.skippedShipped) || 0,
            skippedReadonly: Number(data.skippedReadonly) || 0,
          })
          setList(Array.isArray(data.plugins) ? data.plugins : [])
        } catch (err) {
          if (!aliveRef.current) return
          setFailure(err && err.message ? err.message : String(err))
          // 读失败不要把已有列表清空 —— 网络抖一下不该让方块全没了
          setList((cur) => (cur === null ? [] : cur))
        }
      }, [t])

      useEffect(() => {
        aliveRef.current = true
        refresh()
        const timer = setInterval(refresh, POLL_MS)
        return () => {
          aliveRef.current = false
          clearInterval(timer)
          if (noticeTimerRef.current !== null) {
            clearTimeout(noticeTimerRef.current)
            noticeTimerRef.current = null
          }
        }
      }, [refresh])

      /**
       * 打开抽屉。位置从触发按钮的 rect 算：右对齐按钮右缘，向下展开，
       * 贴到底就往上翻（标题栏在顶上，一般够用，但窗口很矮时别让它跑出屏幕）。
       */
      const openDrawer = useCallback(() => {
        const el = moreBtnRef.current
        let top = 40
        let right = 16
        try {
          if (el && typeof el.getBoundingClientRect === 'function') {
            const rect = el.getBoundingClientRect()
            top = Math.round(rect.bottom + 6)
            right = Math.max(8, Math.round(window.innerWidth - rect.right))
          }
        } catch {
          /* 量不到就用默认位置，总比不弹强 */
        }
        setDrawer({ top, right })
      }, [])

      const closeDrawer = useCallback(() => {
        setDrawer(null)
      }, [])

      // 抽屉开着时按 Esc 关掉；点别处由背板接管
      useEffect(() => {
        if (drawer === null) return undefined
        const onKey = (e) => {
          if (e && e.key === 'Escape') setDrawer(null)
        }
        try {
          window.addEventListener('keydown', onKey)
        } catch {
          return undefined
        }
        return () => {
          try {
            window.removeEventListener('keydown', onKey)
          } catch {
            /* ignore */
          }
        }
      }, [drawer === null])

      /**
       * 打开改名卡。位置跟着右键那一下走（`clientX/clientY`），并夹回屏幕内。
       * 2026-11-03 他定：**左键开关、右键改名** —— 所以这里只被 onContextMenu 调用。
       */
      const openRename = useCallback((item, event) => {
        if (!item || !item.module) return
        const rawX = event && Number.isFinite(event.clientX) ? event.clientX : 80
        const rawY = event && Number.isFinite(event.clientY) ? event.clientY : 80
        const vw = typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : 1280
        const vh = typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 800
        const CARD_W = 252
        const CARD_H = 132
        setRename({
          module: item.module,
          title: item.title,
          top: Math.round(Math.max(8, Math.min(rawY + 4, vh - CARD_H - 8))),
          left: Math.round(Math.max(8, Math.min(rawX + 4, vw - CARD_W - 8))),
        })
        // 预填：已经改过就填当前名字，没改过留空（占位符会提示"留空 = 用原名"）
        setNameDraft(item.custom ? item.title : '')
      }, [])

      const closeRename = useCallback(() => {
        setRename(null)
        setNameDraft('')
      }, [])

      // 改名卡开着时 Esc 也关掉
      useEffect(() => {
        if (rename === null) return undefined
        const onKey = (e) => {
          if (e && e.key === 'Escape') {
            setRename(null)
            setNameDraft('')
          }
        }
        try {
          window.addEventListener('keydown', onKey)
        } catch {
          return undefined
        }
        return () => {
          try {
            window.removeEventListener('keydown', onKey)
          } catch {
            /* ignore */
          }
        }
      }, [rename === null])

      // 窗口尺寸一变，抽屉的固定坐标就过期了（它是打开那一刻算死的）。
      // 与其算一次 resize 重定位，不如直接关掉 —— 重开一次比歪在原处好。
      useEffect(() => {
        if (drawer === null) return undefined
        const onResize = () => setDrawer(null)
        try {
          window.addEventListener('resize', onResize)
        } catch {
          return undefined
        }
        return () => {
          try {
            window.removeEventListener('resize', onResize)
          } catch {
            /* ignore */
          }
        }
      }, [drawer === null])

      /**
       * 改尺寸。`patch.size` 与 `patch.width` 各自独立，但有个联动：
       * 只改高、且宽原来**等于**高（正方形）时，宽跟着走 —— 不然拉一下高就变成扁方块了。
       */
      const applyView = useCallback((patch) => {
        setView((cur) => {
          const curSize = clampSize(cur.size)
          const curWidth = clampWidth(cur.width, curSize)
          const nextSize = clampSize(patch && patch.size !== undefined ? patch.size : curSize)
          let nextWidth
          if (patch && patch.width !== undefined) {
            nextWidth = clampWidth(patch.width, nextSize)
          } else {
            nextWidth = curWidth === curSize ? nextSize : clampWidth(curWidth, nextSize)
          }
          const next = { size: nextSize, width: nextWidth }
          saveView(next)
          viewRef.current = next
          return next
        })
      }, [])

      /**
       * 行上滚轮：默认调高，Shift 调宽。悬停在方块行上才生效，别抢整页的滚动。
       *
       * ⚠️ `Shift+滚轮` 在 Chromium 里会把纵向滚动**转成 `deltaX`、`deltaY=0`**。
       *    只读 deltaY 的话这个手势永远直接 return、什么都不发生 ——
       *    2026-11-03 他就是这么撞上"放大可以、改宽度不行"的。
       *    所以两个轴都读，取绝对值大的那个。
       */
      useEffect(() => {
        if (list === null) return undefined
        const el = rowRef.current
        if (!el || typeof el.addEventListener !== 'function') return undefined
        let lastAt = 0
        const onWheel = (e) => {
          const delta = pickWheelDelta(e)
          if (delta === 0) return
          // 阻止页面滚动 —— 滚轮被我们征用了（这是外部评审提的，其实一开始就有）
          e.preventDefault()
          e.stopPropagation()
          // 节流：一格一格滚时事件密度能到 100Hz，每帧都 setState 纯属浪费。
          // 30ms 大约 33fps，手感上还是连续的。
          const now = typeof e.timeStamp === 'number' && e.timeStamp > 0 ? e.timeStamp : Date.now()
          if (now - lastAt < WHEEL_THROTTLE_MS) return
          lastAt = now
          const step = delta > 0 ? -1 : 1
          const cur = viewRef.current
          if (e.shiftKey) applyView({ width: cur.width + step * 2 })
          else applyView({ size: cur.size + step })
        }
        el.addEventListener('wheel', onWheel, { passive: false })
        return () => {
          try {
            el.removeEventListener('wheel', onWheel)
          } catch {
            /* ignore */
          }
        }
      }, [list === null, applyView])

      /**
       * 按可用宽度决定摆几块（外部评审提的「窗口缩小时 9 块会挤爆」）。
       *
       * 量的是**父容器**、不是行自己：行的宽是内容撑出来的，量它会形成反馈环
       * （少放几块 → 行变窄 → 算出更少 → 继续变窄）。
       * 拿不到 ResizeObserver（或父容器）就退回固定的 9 块，不影响功能。
       */
      const [fitCount, setFitCount] = useState(INLINE_TILES)
      useEffect(() => {
        if (list === null) return undefined
        const el = rowRef.current
        const host = el && el.parentElement ? el.parentElement : null
        if (!host || typeof ResizeObserver !== 'function') return undefined
        const measure = () => {
          const GAP = 4
          let width = 0
          try {
            width = host.getBoundingClientRect().width || 0
          } catch {
            width = 0
          }
          const vw =
            typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : 1280
          // 行自己有 maxWidth: 44vw，别按父容器满宽算
          width = Math.min(width || vw, vw * 0.44)
          const cur = viewRef.current
          const tileW = Math.max(1, cur.width) + GAP
          // 末尾那颗 ▾ 也要占地方
          const chip = Math.round(cur.size * 0.78) + GAP * 2
          const avail = Math.max(tileW, width - chip)
          const n = Math.floor((avail + GAP) / tileW)
          setFitCount(Math.max(1, Math.min(INLINE_TILES, n)))
        }
        const ro = new ResizeObserver(measure)
        ro.observe(host)
        measure()
        return () => {
          try {
            ro.disconnect()
          } catch {
            /* ignore */
          }
        }
      }, [list === null, view.size, view.width])

      /**
       * 改名字。空名字 = 取消自定义（回到插件自己的标题）。
       * 存宿主侧（`$DSH_HOME/plugin-tiles/names.json`），换浏览器不丢。
       */
      const saveName = useCallback(
        async (moduleName) => {
          const target = String(moduleName || '')
          if (target === '') return
          try {
            const res = await fetch(`${ROUTE}/rename`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ module: target, name: nameDraft }),
            })
            const data = await res.json().catch(() => null)
            if (!res.ok || !data || data.ok !== true) {
              flash(`${t('refused')}：${data && data.error ? data.error : `HTTP ${res.status}`}`)
              return
            }
            closeRename()
            refresh()
          } catch (err) {
            flash(`${t('refused')}：${err && err.message ? err.message : String(err)}`)
          }
        },
        [closeRename, flash, nameDraft, refresh, t],
      )

      const toggle = useCallback(
        async (item) => {
          if (!item) return
          // 用 ref 判重：同一帧里连点两次，state 还没提交
          if (busyRef.current === item.id) return
          if (item.readOnly !== null) {
            flash(`${t('readonly')}：${item.readOnly}`)
            return
          }
          busyRef.current = item.id
          setBusyId(item.id)
          try {
            const res = await fetch(`${ROUTE}/toggle`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: item.id, enabled: !item.enabled }),
            })
            const data = await res.json().catch(() => null)
            if (!res.ok || !data || data.ok !== true) {
              const why = data && typeof data.detail === 'string' ? data.detail : data && data.error ? data.error : `HTTP ${res.status}`
              flash(`${t('refused')}：${why}`)
              return
            }
            const next = data.enabled === null ? !item.enabled : data.enabled
            setList((cur) =>
              Array.isArray(cur) ? cur.map((p) => (p.id === item.id ? { ...p, enabled: next } : p)) : cur,
            )
            if (data.application === 'restart-required') {
              flash(t('restart'))
            } else if (data.application === 'failed' || data.application === 'overridden') {
              flash(`${data.application}${data.error && data.error.code ? `：${data.error.code}` : ''}`)
            } else if (data.changed === true) {
              flash(t('applied'))
            }
            // 让宿主那份缓存也作废，别让轮询把刚点的结果盖回去
            refresh()
          } catch (err) {
            flash(`${t('refused')}：${err && err.message ? err.message : String(err)}`)
          } finally {
            busyRef.current = ''
            setBusyId('')
          }
        },
        [flash, refresh, t],
      )

      // ——— 渲染 ———
      // ⚠️ hook 必须全部在上面；这里再 return 是安全的（每次渲染 hook 数一样）
      if (list === null) {
        return h(
          'span',
          { title: t('loading'), style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' } },
          '···',
        )
      }

      // 宿主已经滤过一遍 readOnly；这里再兜一道 —— 改不了的摆出来只会让人以为坏了
      const visible = list.filter((item) => item && item.readOnly === null)
      const shown = visible.slice(0, fitCount)
      const hidden = Math.max(0, visible.length - shown.length)

      /**
       * 一块方块。开/关必须**一眼**分得开，所以两个维度一起用：
       *   · 底色：开 = 整块填暖色；关 = 空
       *   · 角标：开 = ✓；关 = ×
       * 只靠透明度的话，浅色壁纸下几乎看不出来（上一版就是这个问题）。
       */
      const tileOf = (item) => {
        const on = item.enabled === true
        const locked = item.readOnly !== null
        // 尺寸跟着 view 走；字号与角标按比例缩，别在 14px 时糊成一团
        const size = view.size
        const width = view.width
        const font = Math.max(9, Math.round(size * 0.46))
        return h(
          'button',
          {
            key: item.id,
            type: 'button',
            onClick: () => toggle(item),
            // 左键开关、右键改名（他定的）
            onContextMenu: (e) => {
              if (e && typeof e.preventDefault === 'function') e.preventDefault()
              openRename(item, e)
            },
            disabled: busyId === item.id,
            title: [
              item.title,
              item.module ? item.module : '',
              on ? t('on') : t('off'),
              locked ? t('readonly') : '',
              item.self ? t('selfTag') : '',
            ]
              .filter((s) => s !== '')
              .join('\n'),
            'aria-label': `${item.title} ${on ? t('on') : t('off')}`,
            'aria-pressed': on,
            style: {
              position: 'relative',
              flex: '0 0 auto',
              width,
              height: size,
              padding: 0,
              borderRadius: Math.max(4, Math.round(size * 0.25)),
              fontSize: font,
              fontWeight: 700,
              lineHeight: 1,
              // 名字那层是块级 span，要让它居中、并在放不下时省略
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: busyId === item.id ? 'progress' : 'pointer',
              border: on ? TILE_ON.border : TILE_OFF.border,
              background: on ? TILE_ON.background : TILE_OFF.background,
              color: on ? TILE_ON.color : TILE_OFF.color,
              boxShadow: on ? TILE_ON.boxShadow : TILE_OFF.boxShadow,
              opacity: locked ? 0.4 : on ? 1 : 0.62,
              overflow: 'hidden',
            },
          },
          // 显示**整个名字**，放不下就省略号。
          // 2026-11-03 他问「怎么只能显示一个字符呢」——之前只画了首字（initial），
          // 那是 24px 正方形时代的保守做法；现在宽度可调，就该让名字自己撑满。
          h(
            'span',
            {
              style: {
                display: 'block',
                maxWidth: '100%',
                padding: '0 3px',
                boxSizing: 'border-box',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            item.title,
          ),
        )
      }

      const tiles = shown.map(tileOf)

      const tail = []
      // 抽屉入口：**常驻**的 `▾`，不再只在"超出 9 个"时出现。
      // 为什么改：抽屉里现在有尺寸控件和全部插件，插件不足 9 个时如果没有这个按钮，
      // 他就只能靠滚轮调大小、永远打不开抽屉。原来那颗 `+N` 只表达"还有几个"，
      // 2026-11-03 他说「把这个做成这个」——换成小三角，作为固定的展开键。
      tail.push(
        h(
          'button',
          {
            key: 'more',
            ref: moreBtnRef,
            type: 'button',
            onClick: openDrawer,
            title: hidden > 0 ? t('more', { n: hidden }) : t('openDrawer'),
            'aria-label': hidden > 0 ? t('more', { n: hidden }) : t('openDrawer'),
            'aria-expanded': drawer !== null,
            style: {
              flex: '0 0 auto',
              width: Math.max(18, Math.round(view.size * 0.78)),
              height: view.size,
              padding: 0,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: Math.max(8, Math.round(view.size * 0.36)),
              lineHeight: 1,
              borderRadius: Math.max(4, Math.round(view.size * 0.25)),
              cursor: 'pointer',
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-layer-1)',
              color: 'var(--dsw-alias-label-secondary)',
            },
          },
          '▾',
        ),
      )
      if (failure !== '') {
        tail.push(
          h(
            'span',
            {
              key: 'fail',
              title: failure,
              style: { fontSize: 11, color: 'var(--dsw-alias-state-warn-primary)', flex: '0 0 auto' },
            },
            '!',
          ),
        )
      }
      if (notice !== null) {
        tail.push(
          h(
            'span',
            {
              key: 'notice',
              style: {
                fontSize: 10,
                color: 'var(--dsw-alias-label-secondary)',
                whiteSpace: 'nowrap',
                flex: '0 0 auto',
                maxWidth: 190,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              },
            },
            notice.text,
          ),
        )
      }

      if (tiles.length === 0) {
        // 没有可开关的：给一句说明，但**仍然保留展开键** ——
        // 抽屉里还有尺寸控件，全滤空的时候也不能把入口一起关掉。
        // 三种情况要分得开：一条都没装 / 装了但都不能改 / 服务没就绪。
        const skippedReadonly = stats ? stats.skippedReadonly : 0
        const nothingSwitchable = skippedReadonly > 0 || (list.length > 0 && visible.length === 0)
        return h(
          'div',
          {
            ref: rowRef,
            className: `${PREFIX}row`,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              maxWidth: '44vw',
              overflowX: 'auto',
              overflowY: 'hidden',
              flexWrap: 'nowrap',
            },
          },
          h(
            'span',
            {
              title: nothingSwitchable ? t('noToggleable') : t('empty'),
              style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
            },
            nothingSwitchable ? t('noToggleable') : t('label') + ' 0',
          ),
          tail,
        )
      }

      const row = h(
        'div',
        {
          ref: rowRef,
          className: `${PREFIX}row`,
          title: t('sizeHint'),
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            // 别让它把标题挤走：超出就横向滚，最多占四成宽
            maxWidth: '44vw',
            overflowX: 'auto',
            overflowY: 'hidden',
            flexWrap: 'nowrap',
          },
        },
        tiles,
        tail,
      )

      // ——— 抽屉：全部插件，一行一个，可勾选 ———
      let panel = null
      if (drawer !== null) {
        const rows = visible.map((item) => {
          const on = item.enabled === true
          const locked = item.readOnly !== null

          return h(
            'div',
            {
              key: `row-${item.id}`,
              style: { display: 'flex', alignItems: 'center', padding: '0 4px 0 0' },
            },
            h(
              'button',
              {
                type: 'button',
                onClick: () => toggle(item),
                // 左键开关、右键改名（和方块上同一套手感）
                onContextMenu: (e) => {
                  if (e && typeof e.preventDefault === 'function') e.preventDefault()
                  openRename(item, e)
                },
                disabled: busyId === item.id,
                title: item.module,
                'aria-pressed': on,
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  flex: '1 1 auto',
                  minWidth: 0,
                  boxSizing: 'border-box',
                  padding: '5px 8px',
                  fontSize: 12,
                  lineHeight: 1.3,
                  textAlign: 'left',
                  border: 'none',
                  borderRadius: 8,
                  cursor: busyId === item.id ? 'progress' : 'pointer',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-primary)',
                  opacity: locked ? 0.55 : 1,
                },
              },
              // 勾选框：开 = 填色带勾
              h(
                'span',
                {
                  style: {
                    width: 14,
                    height: 14,
                    flex: '0 0 auto',
                    borderRadius: 4,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 10,
                    lineHeight: 1,
                    border: on ? TILE_ON.border : '1px solid var(--dsw-alias-border-l2)',
                    background: on ? TILE_ON.background : 'transparent',
                    color: on ? TILE_ON.color : 'var(--dsw-alias-label-secondary)',
                  },
                },
                // 关的时候也给个 ×，别只靠"没填色"这一个维度
                on ? '✓' : '×',
              ),
              h(
                'span',
                {
                  style: {
                    flex: '1 1 auto',
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                },
                item.title,
              ),
              locked
                ? h(
                    'span',
                    {
                      style: { flex: '0 0 auto', fontSize: 9, color: 'var(--dsw-alias-label-secondary)' },
                    },
                    t('readonlyShort'),
                  )
                : null,
            ),
          )
        })

        panel = h(
          'div',
          {
            onClick: closeDrawer,
            style: {
              position: 'fixed',
              inset: 0,
              zIndex: 9100,
              background: 'rgba(8,10,14,.12)',
            },
          },
          h(
            'div',
            {
              onClick: (e) => e.stopPropagation(),
              style: {
                position: 'fixed',
                top: drawer.top,
                right: drawer.right,
                width: 264,
                maxWidth: 'calc(100vw - 16px)',
                maxHeight: 'min(58vh, 460px)',
                display: 'flex',
                flexDirection: 'column',
                borderRadius: 12,
                border: '1px solid var(--dsw-alias-border-l2)',
                background: 'var(--dsw-alias-bg-overlay)',
                color: 'var(--dsw-alias-label-primary)',
                boxShadow: '0 16px 40px rgba(8,10,14,.45)',
                overflow: 'hidden',
                colorScheme: 'inherit',
              },
            },
            // 头
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 8px 7px 11px',
                  borderBottom: '1px solid var(--dsw-alias-border-l1)',
                  // 抽屉是 flex 列；不锁住的话列表一长，头部和尺寸控件会被按比例压扁
                  flex: '0 0 auto',
                },
              },
              h(
                'span',
                { style: { display: 'inline-block', width: 3, height: 13, borderRadius: 2, background: 'rgb(232,178,58)' } },
              ),
              h('span', { style: { fontSize: 12, fontWeight: 600 } }, t('label')),
              h('span', {
                style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' },
              }, String(visible.length)),
              // 当前尺寸读数：宽×高。改哪个维度一眼看得出来，也方便他回报问题时说数
              h('span', {
                title: t('sizeHint'),
                style: {
                  fontSize: 10,
                  color: 'var(--dsw-alias-label-secondary)',
                  fontVariantNumeric: 'tabular-nums',
                },
              }, `${view.width}×${view.size}`),
              h('div', { style: { flex: '1 1 auto' } }),
              h(
                'button',
                {
                  type: 'button',
                  onClick: closeDrawer,
                  title: t('close'),
                  'aria-label': t('close'),
                  style: {
                    width: 20,
                    height: 20,
                    padding: 0,
                    border: 'none',
                    borderRadius: 6,
                    background: 'transparent',
                    color: 'var(--dsw-alias-label-secondary)',
                    cursor: 'pointer',
                    fontSize: 13,
                    lineHeight: 1,
                  },
                },
                '×',
              ),
            ),
            // 尺寸控制（他说「这些可以调整大小长短」）
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 5,
                  padding: '7px 10px',
                  borderBottom: '1px solid var(--dsw-alias-border-l1)',
                  // 关键：不许被列表挤扁。少了这一条，插件一多，「长短」那行会被压到看不见
                  flex: '0 0 auto',
                },
              },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                h(
                  'span',
                  { style: { flex: '0 0 auto', width: 30, fontSize: 10, color: 'var(--dsw-alias-label-secondary)' } },
                  t('tileSize'),
                ),
                h('input', {
                  type: 'range',
                  min: SIZE_MIN,
                  max: SIZE_MAX,
                  step: 1,
                  value: view.size,
                  onChange: (e) => applyView({ size: Number(e.target.value) }),
                  'aria-label': t('tileSize'),
                  style: { flex: '1 1 auto', minWidth: 50, height: 14, margin: 0, cursor: 'pointer', accentColor: 'rgb(232,178,58)' },
                }),
                h('input', {
                  type: 'number',
                  min: SIZE_MIN,
                  max: SIZE_MAX,
                  step: 1,
                  value: view.size,
                  onChange: (e) => applyView({ size: Number(e.target.value) }),
                  'aria-label': t('tileSize'),
                  style: {
                    width: 44,
                    flex: '0 0 auto',
                    padding: '2px 4px',
                    fontSize: 11,
                    textAlign: 'right',
                    borderRadius: 6,
                    border: '1px solid var(--dsw-alias-border-l1)',
                    background: 'var(--dsw-alias-bg-layer-1)',
                    color: 'var(--dsw-alias-label-primary)',
                    fontFamily: 'inherit',
                    boxSizing: 'border-box',
                  },
                }),
              ),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                h(
                  'span',
                  { style: { flex: '0 0 auto', width: 30, fontSize: 10, color: 'var(--dsw-alias-label-secondary)' } },
                  t('tileWidth'),
                ),
                h('input', {
                  type: 'range',
                  min: WIDTH_MIN,
                  max: WIDTH_MAX,
                  step: 1,
                  value: view.width,
                  onChange: (e) => applyView({ width: Number(e.target.value) }),
                  'aria-label': t('tileWidth'),
                  style: { flex: '1 1 auto', minWidth: 50, height: 14, margin: 0, cursor: 'pointer', accentColor: 'rgb(232,178,58)' },
                }),
                h('input', {
                  type: 'number',
                  min: WIDTH_MIN,
                  max: WIDTH_MAX,
                  step: 1,
                  value: view.width,
                  onChange: (e) => applyView({ width: Number(e.target.value) }),
                  'aria-label': t('tileWidth'),
                  style: {
                    width: 44,
                    flex: '0 0 auto',
                    padding: '2px 4px',
                    fontSize: 11,
                    textAlign: 'right',
                    borderRadius: 6,
                    border: '1px solid var(--dsw-alias-border-l1)',
                    background: 'var(--dsw-alias-bg-layer-1)',
                    color: 'var(--dsw-alias-label-primary)',
                    fontFamily: 'inherit',
                    boxSizing: 'border-box',
                  },
                }),
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => applyView({ size: TILE, width: TILE }),
                    title: t('resetSize'),
                    style: {
                      flex: '0 0 auto',
                      width: 18,
                      height: 18,
                      padding: 0,
                      fontSize: 10,
                      lineHeight: 1,
                      cursor: 'pointer',
                      borderRadius: 5,
                      border: '1px solid var(--dsw-alias-border-l1)',
                      background: 'transparent',
                      color: 'var(--dsw-alias-label-secondary)',
                    },
                  },
                  '↺',
                ),
              ),
            ),
            // 列表
            h(
              'div',
              {
                className: `${PREFIX}drawer`,
                style: { flex: '1 1 auto', overflowY: 'auto', padding: '4px 4px 6px', minHeight: 0 },
              },
              visible.length === 0
                ? h(
                    'div',
                    {
                      style: {
                        padding: '12px 8px',
                        fontSize: 11,
                        color: 'var(--dsw-alias-label-secondary)',
                        textAlign: 'center',
                      },
                    },
                    t('drawerEmpty'),
                  )
                : rows,
            ),
          ),
        )
      }

      // ——— 改名卡：右键方块 / 右键抽屉行都会弹这个 ———
      const renameCard =
        rename === null
          ? null
          : h(
              'div',
              {
                // 透明背板：点别处就关。不铺底色，免得盖住别的界面
                onClick: closeRename,
                style: { position: 'fixed', inset: 0, zIndex: 9200, background: 'transparent' },
              },
              h(
                'div',
                {
                  onClick: (e) => e.stopPropagation(),
                  style: {
                    position: 'fixed',
                    top: rename.top,
                    left: rename.left,
                    width: 252,
                    maxWidth: 'calc(100vw - 16px)',
                    padding: '10px 10px 9px',
                    borderRadius: 12,
                    border: '1px solid var(--dsw-alias-border-l2)',
                    background: 'var(--dsw-alias-bg-overlay)',
                    color: 'var(--dsw-alias-label-primary)',
                    boxShadow: '0 16px 40px rgba(8,10,14,.45)',
                    colorScheme: 'inherit',
                  },
                },
                h(
                  'div',
                  {
                    title: rename.title,
                    style: {
                      fontSize: 10,
                      color: 'var(--dsw-alias-label-secondary)',
                      marginBottom: 6,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    },
                  },
                  `${t('rename')} · ${rename.title}`,
                ),
                h('input', {
                  type: 'text',
                  value: nameDraft,
                  placeholder: t('namePlaceholder'),
                  'aria-label': t('rename'),
                  onChange: (e) => setNameDraft(e.target.value),
                  onKeyDown: (e) => {
                    if (e.key === 'Enter') saveName(rename.module)
                    if (e.key === 'Escape') closeRename()
                  },
                  style: {
                    width: '100%',
                    boxSizing: 'border-box',
                    padding: '5px 8px',
                    fontSize: 12,
                    borderRadius: 8,
                    border: '1px solid rgb(232,178,58)',
                    background: 'var(--dsw-alias-bg-layer-1)',
                    color: 'var(--dsw-alias-label-primary)',
                    fontFamily: 'inherit',
                  },
                }),
                h(
                  'div',
                  { style: { display: 'flex', gap: 6, marginTop: 8, justifyContent: 'flex-end' } },
                  h(
                    'button',
                    {
                      type: 'button',
                      onClick: closeRename,
                      style: {
                        padding: '4px 10px',
                        fontSize: 11,
                        borderRadius: 7,
                        cursor: 'pointer',
                        border: '1px solid var(--dsw-alias-border-l1)',
                        background: 'transparent',
                        color: 'var(--dsw-alias-label-secondary)',
                      },
                    },
                    t('cancelName'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      onClick: () => saveName(rename.module),
                      style: {
                        padding: '4px 10px',
                        fontSize: 11,
                        borderRadius: 7,
                        cursor: 'pointer',
                        border: '1px solid rgb(232,178,58)',
                        background: 'rgba(232,178,58,.16)',
                        color: 'rgb(232,178,58)',
                      },
                    },
                    t('saveName'),
                  ),
                ),
              ),
            )

      return h(React.Fragment, null, row, panel, renameCard)
    }

    /**
     * 错误边界：渲染期抛错会被 slot 判成 active:false，界面上什么都不出现、
     * 也没有任何提示（鲸鱼那边踩过）。有边界之后，出错会**画在屏幕上**。
     */
    class TilesBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failure: null }
      }
      static getDerivedStateFromError(err) {
        return { failure: err }
      }
      render() {
        const err = this.state.failure
        if (err === null || err === undefined) return h(PluginTiles, this.props)
        return h(
          'span',
          {
            title: err && err.message ? err.message : String(err),
            style: { fontSize: 11, color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'nowrap' },
          },
          '插件方块渲染失败',
        )
      }
    }

    const STYLE_TEXT = `
.${PREFIX}row::-webkit-scrollbar { height: 0; }
`

    // ——————————————————————————————————————————————————————————————
    // 入口
    // ——————————————————————————————————————————————————————————————
    function apply(ctx) {
      if (!ctx) return
      const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
      const t = makeTranslator(locale)

      const register = (scope) => {
        if (!scope || !scope.slots) return
        try {
          scope.slots.inject(SLOT, () =>
            scope.slots.register(
              { name: SLOT, id: 'plugin-tiles', order: 40, label: () => t('label') },
              (props) =>
                h(
                  React.Fragment,
                  null,
                  h('style', null, STYLE_TEXT),
                  h(TilesBoundary, { ...props, t }),
                ),
            ),
          )
        } catch (err) {
          console.warn('[plugin-tiles] 挂载失败', err)
        }
      }

      if (typeof ctx.inject === 'function') {
        ctx.inject(['slots'], register)
      } else {
        register(ctx)
      }
    }

    // 自检出口：只有沙箱里设了标记才挂上去，生产返回形状与以前一致
    const api = { apply }
    if (typeof window !== 'undefined' && window.__DESK_TEST__ === true) {
      api.__test = {
        MESSAGES,
        makeTranslator,
        ROUTE,
        SLOT,
        INLINE_TILES,
        TILE,
        TilesBoundary,
        // 尺寸：纯函数 + 范围常量 + localStorage 键
        LS_VIEW,
        SIZE_MIN,
        SIZE_MAX,
        WIDTH_MIN,
        WIDTH_MAX,
        clampSize,
        clampWidth,
        loadView,
        pickWheelDelta,
      }
    }
    return api
  },
})
