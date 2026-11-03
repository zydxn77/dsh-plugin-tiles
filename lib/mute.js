/**
 * mute.js —— 「全部静音」的账本。
 *
 * 他要的（2026-11-03）：「一键禁用所有非核心插件，再点一下恢复之前的勾选状态」。
 *
 * 关键不是"关"，是**记住关之前哪些是开的**。所以落一份快照：
 *   `{ active: true, ids: [...当时开着的 entryId...] }`
 * 恢复时只回填这份名单里、且现在还存在、且当前是关的那些 —— 不动别的。
 *
 * 存宿主侧（`$DSH_HOME/plugin-tiles/mute.json`），不放浏览器：
 * 静音往往跨越一次重启（大部分插件改完要重启才生效），浏览器那份会跟着会话丢。
 *
 * 不依赖 DSH，路径由调用方传入，所以能单测。
 */

import fs from 'node:fs'
import path from 'node:path'

export const MUTE_FILE = 'mute.json'
/** 名单上限。目前插件总数两百出头，留点余量 */
export const MAX_IDS = 5000

export function openMute(dir) {
  const file = path.join(dir, MUTE_FILE)

  /** @returns {{active:boolean, ids:string[]}} 坏文件当"没静音" */
  function read() {
    let parsed = null
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      parsed = null
    }
    if (!parsed || typeof parsed !== 'object' || parsed.active !== true) return { active: false, ids: [] }
    const list = Array.isArray(parsed.ids) ? parsed.ids : []
    const ids = []
    const seen = new Set()
    for (const raw of list) {
      if (typeof raw !== 'string') continue
      const id = raw.trim()
      if (id === '' || seen.has(id)) continue
      seen.add(id)
      ids.push(id)
      if (ids.length >= MAX_IDS) break
    }
    // active 但没有名单 = 无法恢复。当成没静音，别把人卡在"恢复不了"的状态里
    if (ids.length === 0) return { active: false, ids: [] }
    return { active: true, ids }
  }

  function write(state) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      file,
      `${JSON.stringify({ active: true, ids: state.ids, at: Date.now() }, null, 2)}\n`,
      'utf8',
    )
  }

  /** 清掉账本 = 不再处于"静音"状态 */
  function clear() {
    try {
      fs.unlinkSync(file)
    } catch (err) {
      // 文件本来就不在，不算错
      if (err && err.code !== 'ENOENT') throw err
    }
  }

  return { file, read, write, clear }
}
