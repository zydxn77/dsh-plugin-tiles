/**
 * names.js —— 给插件起自己的名字。
 *
 * 他原话（2026-11-03）：「我想自定义名字」。
 *
 * 存在宿主这边（`$DSH_HOME/plugin-tiles/names.json`），不放 localStorage：
 *   · 换浏览器 / 清缓存不该丢；
 *   · 和第 3 行的「显示名」是同一类数据，放一处好找。
 *
 * **键用 `moduleName`，不用 `entryId`**：entryId 是加载器条的 id（`include:xxx`），
 * 重装/改 patch 就可能变；模块名是包身份，稳定。同一个模块有多条时，
 * 改名会同时作用于它们 —— 那正是他想要的（同一个插件）。
 *
 * 不依赖 DSH，路径由调用方传入，所以能单测。
 */

import fs from 'node:fs'
import path from 'node:path'

export const NAMES_FILE = 'names.json'
/** 名字上限。方块上只显示一个字，抽屉里也就一行，24 够用了 */
export const MAX_NAME = 24

/**
 * 清洗名字。
 * @returns {string|null} 合法返回整理后的名字；空/非法返回 null（表示"取消自定义"）
 */
export function normalizeCustomName(input) {
  if (typeof input !== 'string') return null
  // 换行会把抽屉的行撑开，折成空格
  const name = input.replace(/[\r\n\t]+/g, ' ').trim()
  if (name === '') return null
  return name.slice(0, MAX_NAME)
}

/** 模块名的清洗：只要非空字符串，别把奇怪的东西当键 */
export function normalizeModuleKey(input) {
  if (typeof input !== 'string') return null
  const key = input.trim()
  if (key === '') return null
  return key.slice(0, 200)
}

export function openNames(dir) {
  const file = path.join(dir, NAMES_FILE)

  /** 读全部自定义名。坏文件当没有 —— 这只是显示层的东西，不值得为它崩 */
  function all() {
    let parsed = null
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      parsed = null
    }
    const out = {}
    const source = parsed && typeof parsed === 'object' && parsed.names && typeof parsed.names === 'object'
      ? parsed.names
      : null
    if (source === null) return out
    for (const [key, value] of Object.entries(source)) {
      const moduleKey = normalizeModuleKey(key)
      const name = normalizeCustomName(value)
      if (moduleKey !== null && name !== null) out[moduleKey] = name
    }
    return out
  }

  function write(names) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, names }, null, 2)}\n`, 'utf8')
  }

  /**
   * 设一个名字。`name` 为空 = 取消自定义（回到插件自己的标题）。
   * @returns {Record<string,string>} 落盘后的全量映射
   */
  function set(moduleName, name) {
    const key = normalizeModuleKey(moduleName)
    if (key === null) {
      const err = new Error('缺少模块名')
      err.code = 'INVALID'
      throw err
    }
    const names = all()
    const cleaned = normalizeCustomName(name)
    if (cleaned === null) delete names[key]
    else names[key] = cleaned
    write(names)
    return names
  }

  return { file, all, set }
}
