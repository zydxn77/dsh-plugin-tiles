/**
 * 自定义名字（`lib/names.js` + `applyCustomNames`）自检。
 * 跑法：node tests/names.selftest.mjs
 *
 * 他原话：「我想自定义名字」（2026-11-03）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  openNames,
  normalizeCustomName,
  normalizeModuleKey,
  NAMES_FILE,
  MAX_NAME,
} from '../lib/names.js'
import { applyCustomNames } from '../lib/index.js'

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
function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiles-names-'))
  try {
    fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

check('normalizeCustomName：折行、去空、截断、空 = 取消', () => {
  eq(normalizeCustomName('我的鲸鱼'), '我的鲸鱼', '普通')
  eq(normalizeCustomName('  a\nb\tc  '), 'a b c', '换行折成空格')
  eq(normalizeCustomName('   '), null, '全空白 = 取消')
  eq(normalizeCustomName(''), null, '空串 = 取消')
  eq(normalizeCustomName(null), null, 'null')
  eq(normalizeCustomName(42), null, '非字符串')
  eq(normalizeCustomName('字'.repeat(100)).length, MAX_NAME, '截断')
})

check('normalizeModuleKey：空的不算，长的截断', () => {
  eq(normalizeModuleKey('dsh-wcdb'), 'dsh-wcdb', '普通')
  eq(normalizeModuleKey('  dsh-wcdb  '), 'dsh-wcdb', '去首尾空白')
  eq(normalizeModuleKey(''), null, '空')
  eq(normalizeModuleKey(undefined), null, 'undefined')
})

check('没设过 → 空映射', () => {
  withDir((dir) => {
    eq(openNames(dir).all(), {}, '空的')
  })
})

check('设一个名字，换实例还能读到', () => {
  withDir((dir) => {
    const store = openNames(dir)
    const after = store.set('dsh-whale-desk', '小鲸鱼')
    eq(after, { 'dsh-whale-desk': '小鲸鱼' }, '返回全量')
    eq(openNames(dir).all(), { 'dsh-whale-desk': '小鲸鱼' }, '重新读盘')
    ok(fs.existsSync(path.join(dir, NAMES_FILE)), '应当落盘')
  })
})

check('空名字 = 取消自定义（键要删掉，不是留空串）', () => {
  withDir((dir) => {
    const store = openNames(dir)
    store.set('dsh-wcdb', '微信')
    eq(store.all(), { 'dsh-wcdb': '微信' }, '先有')
    eq(store.set('dsh-wcdb', ''), {}, '取消之后应当没有这个键')
    eq(store.all(), {}, '落盘也干净')
  })
})

check('缺模块名 → INVALID，不写盘', () => {
  withDir((dir) => {
    const store = openNames(dir)
    for (const bad of ['', '   ', null, undefined, 42]) {
      let threw = false
      try {
        store.set(bad, '名字')
      } catch (e) {
        threw = true
        eq(e.code, 'INVALID', 'code')
      }
      ok(threw, `应当拒绝 ${JSON.stringify(bad)}`)
    }
    eq(store.all(), {}, '一个都没写进去')
  })
})

check('坏文件 / 脏值 → 当没有，不崩', () => {
  withDir((dir) => {
    fs.writeFileSync(path.join(dir, NAMES_FILE), '{不是 JSON', 'utf8')
    eq(openNames(dir).all(), {}, '坏 JSON')
    fs.writeFileSync(
      path.join(dir, NAMES_FILE),
      JSON.stringify({ version: 1, names: { ok: '好', '': '空键', bad: 42 } }),
      'utf8',
    )
    const all = openNames(dir).all()
    eq(all, { ok: '好' }, '只留合法的（空键与非字符串都丢掉）')
  })
})

check('applyCustomNames：改名之后标题和方块上的字都要换', () => {
  const plugins = [
    { id: 'a', module: 'dsh-whale-desk', title: '小鲸鱼交互台', initial: '小', enabled: true },
    { id: 'b', module: 'dsh-wcdb', title: '微信库', initial: '微', enabled: false },
  ]
  const out = applyCustomNames(plugins, { 'dsh-whale-desk': '阿鲸' })
  eq(out[0].title, '阿鲸', '用自定义名')
  eq(out[0].initial, '阿', '方块上的字跟着换')
  eq(out[0].custom, true, '标记为自定义')
  eq(out[1].title, '微信库', '没改的保持原样')
  eq(out[1].custom, false, '没改的 custom 是 false')
  // 不能改动原对象（宿主缓存里那份还要用）
  eq(plugins[0].title, '小鲸鱼交互台', '不要原地改')
})

check('applyCustomNames：垃圾输入不炸', () => {
  const plugins = [{ id: 'a', module: 'm', title: '原名', initial: '原' }]
  eq(applyCustomNames(plugins, null)[0].title, '原名', 'null 映射')
  eq(applyCustomNames(plugins, { m: '' })[0].title, '原名', '空名不算自定义')
  eq(applyCustomNames(null, { m: 'x' }), [], 'null 列表')
})

// `applyCustomNames` 从 lib/index.js 里 import 会连 fs 一起拉进来，这里只验它不炸
check('lib/index.js 能被 import（含新加的 fs/path/names 依赖）', () => {
  ok(typeof applyCustomNames === 'function', '导出在')
})

const total = pass + failures.length
if (failures.length === 0) {
  console.log(`OK ${pass}/${total}（自定义名字）`)
  process.exit(0)
}
console.log(`FAIL ${failures.length}/${total}`)
for (const f of failures) console.log(`  - ${f}`)
process.exit(1)
