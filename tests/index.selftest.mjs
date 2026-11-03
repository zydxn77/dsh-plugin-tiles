/**
 * 市场索引自检：把 `index.json` 按 DSH「插件市场索引格式 1」的规则过一遍。
 * 跑法：node tests/index.selftest.mjs
 *
 * ⚠️ 老实说：这**不是**官方校验器本身，是照着 `@deepseek-ai/dsh-plugin-market-index`
 *    里 `parseMarketIndex` 的判据抄的一份镜像。抄的依据是源码里那些
 *    `fail(path, "must be ...")`，规则文本我都写进断言里了，方便对不上时定位。
 *    真校验发生在市场拉索引的时候；这里只求"发之前先自己过一遍，别到那边才炸"。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const index = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
/** 索引将来的落脚点。icon 的相对路径要相对它解析。 */
const INDEX_URL = 'https://example.com/dsh-plugins/index.json'

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

const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const COMMIT = /^[0-9a-f]{40}$/
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const LANG_ID = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/
const SEMVER_RANGE = /^[\^~<>=]*\s*\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?$/

/** 本地化文本：必须是对象、键是小写语言 id、且**必须含 en** */
function assertLocalized(value, where) {
  ok(value && typeof value === 'object' && !Array.isArray(value), `${where} 必须是对象`)
  for (const key of Object.keys(value)) {
    ok(LANG_ID.test(key), `${where}.${key} 必须是小写语言 id`)
    ok(typeof value[key] === 'string' && value[key].trim() !== '', `${where}.${key} 必须是非空字符串`)
  }
  ok(Object.hasOwn(value, 'en'), `${where} 必须含 en（校验器硬要求）`)
}

function assertHttpUrl(text, where) {
  ok(typeof text === 'string', `${where} 必须是字符串`)
  const url = new URL(text)
  ok(url.protocol === 'https:' || url.protocol === 'http:', `${where} 必须是 http(s)`)
  ok(url.username === '' && url.password === '', `${where} 不能带凭据`)
  ok(!url.href.includes('?') && !url.href.includes('#'), `${where} 不能带 query/fragment`)
  return url
}

function resolveIcon(text, where) {
  ok(typeof text === 'string' && text !== '', `${where} 必须是非空字符串`)
  if (text.startsWith('data:')) {
    const m = /^data:image\/(?:svg\+xml|png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(text)
    ok(m !== null, `${where} 必须是 base64 的 svg/png/jpeg/webp data URL`)
    const bytes = (m[1].length / 4) * 3
    ok(bytes <= 32768, `${where} 解码后不能超过 32 KiB（现在约 ${Math.round(bytes / 1024)} KiB）`)
    return 'inline'
  }
  const base = new URL(INDEX_URL)
  const resolved = new URL(text, base)
  ok(
    resolved.protocol === 'https:' || resolved.origin === base.origin,
    `${where} 必须解析到 https 或与索引同源`,
  )
  return resolved
}

// ————————————————————————————————————————————————————————————
// 顶层
// ————————————————————————————————————————————————————————————

check('format 必须是数字 1', () => {
  eq(index.format, 1, 'format')
})

check('索引标题必填，且必须含 en', () => {
  assertLocalized(index.title, '$.title')
})

check('索引描述可选，但给了就得合法', () => {
  if (index.description === undefined) return
  assertLocalized(index.description, '$.description')
})

check('plugins 必须是非空数组', () => {
  ok(Array.isArray(index.plugins) && index.plugins.length > 0, '$.plugins')
})

// ————————————————————————————————————————————————————————————
// 每个插件
// ————————————————————————————————————————————————————————————

for (const [i, plugin] of index.plugins.entries()) {
  const at = `$.plugins[${i}]`

  check(`${at}.name 是合法 npm 包名`, () => {
    ok(typeof plugin.name === 'string', `${at}.name 必须是字符串`)
    ok(plugin.name.length <= 214, `${at}.name 太长`)
    ok(PACKAGE_NAME.test(plugin.name), `${at}.name 不是合法包名：${plugin.name}`)
  })

  check(`${at} 的本地化字段与图标合法`, () => {
    if (plugin.title !== undefined) assertLocalized(plugin.title, `${at}.title`)
    if (plugin.description !== undefined) assertLocalized(plugin.description, `${at}.description`)
    if (plugin.icon !== undefined) resolveIcon(plugin.icon, `${at}.icon`)
    if (plugin.homepage !== undefined) assertHttpUrl(plugin.homepage, `${at}.homepage`)
    if (plugin.repository !== undefined) {
      assertHttpUrl(plugin.repository.url, `${at}.repository.url`)
      if (plugin.repository.directory !== undefined) {
        ok(
          !plugin.repository.directory.split('/').some((s) => s === '.' || s === '..' || s === ''),
          `${at}.repository.directory 不能有 . 或 ..`,
        )
      }
    }
  })

  check(`${at}.versions 非空、版本号精确、时间戳是 Unix 秒`, () => {
    ok(Array.isArray(plugin.versions) && plugin.versions.length > 0, `${at}.versions`)
    const seen = new Set()
    for (const [j, v] of plugin.versions.entries()) {
      const p = `${at}.versions[${j}]`
      ok(EXACT_SEMVER.test(v.version), `${p}.version 必须是精确 SemVer：${v.version}`)
      ok(!seen.has(v.version), `${p}.version 重复：${v.version}`)
      seen.add(v.version)
      ok(Number.isInteger(v.publishTimestamp), `${p}.publishTimestamp 必须是整数`)
      ok(v.publishTimestamp >= 0 && v.publishTimestamp < 1e11, `${p}.publishTimestamp 越界（要 Unix 秒）`)
      // 2026 年的时间戳是 10 位；13 位就是误用了毫秒
      ok(String(v.publishTimestamp).length <= 11, `${p}.publishTimestamp 像是毫秒，要秒`)
    }
  })

  check(`${at}.versions[].source 只能是 npm 或 git`, () => {
    for (const [j, v] of plugin.versions.entries()) {
      const p = `${at}.versions[${j}].source`
      ok(v.source && typeof v.source === 'object', `${p} 必须有`)
      if (v.source.type === 'npm') {
        if (v.source.registry !== undefined) assertHttpUrl(v.source.registry, `${p}.registry`)
      } else if (v.source.type === 'git') {
        assertHttpUrl(v.source.url, `${p}.url`)
        ok(COMMIT.test(v.source.commit), `${p}.commit 必须是 40 位小写十六进制`)
        if (v.source.path !== undefined) {
          ok(!v.source.path.split('/').some((s) => s === '.' || s === '..'), `${p}.path 不能有 . 或 ..`)
        }
      } else {
        throw new Error(`${p}.type 必须是 "npm" 或 "git"，实际 ${JSON.stringify(v.source.type)}`)
      }
    }
  })

  check(`${at}.versions[].engines.dsh 是 SemVer 范围`, () => {
    for (const [j, v] of plugin.versions.entries()) {
      if (v.engines === undefined || v.engines.dsh === undefined) continue
      const p = `${at}.versions[${j}].engines.dsh`
      ok(!String(v.engines.dsh).startsWith('workspace:'), `${p} 不能是 workspace: 范围`)
      ok(SEMVER_RANGE.test(String(v.engines.dsh)), `${p} 必须是 SemVer 范围：${v.engines.dsh}`)
    }
  })
}

check('插件名在索引里不重复', () => {
  const names = index.plugins.map((p) => p.name)
  eq(new Set(names).size, names.length, '有重复')
})

// ————————————————————————————————————————————————————————————
// 与包本身对得上
// ————————————————————————————————————————————————————————————

check('索引里的包名 / 版本要和 package.json 一致', () => {
  const mine = index.plugins.find((p) => p.name === pkg.name)
  ok(mine !== undefined, `索引里没有 ${pkg.name}`)
  const versions = mine.versions.map((v) => v.version)
  ok(versions.includes(pkg.version), `索引里没有 ${pkg.name}@${pkg.version}（有：${versions.join(', ')}）`)
})

check('package.json 能发布：去掉 private、有仓库与作者', () => {
  ok(pkg.private !== true, 'private 还在，npm 会拒绝发布')
  ok(typeof pkg.author === 'string' && pkg.author !== '', '缺 author')
  ok(pkg.repository && typeof pkg.repository.url === 'string', '缺 repository.url')
  ok(pkg.version === index.plugins.find((p) => p.name === pkg.name).versions[0].version, '版本要对齐')
})

check('图标文件真的在，而且会被打进包里', () => {
  const iconPath = path.join(root, 'icon.svg')
  ok(fs.existsSync(iconPath), 'icon.svg 不存在')
  ok(pkg.files.includes('icon.svg'), 'package.json 的 files 里没有 icon.svg，发上去就没图标了')
})

check('索引文件不会被发进 npm 包（它是给托管用的）', () => {
  ok(!pkg.files.includes('index.json'), 'index.json 不该进包')
})

// ————————————————————————————————————————————————————————————

const total = pass + failures.length
if (failures.length === 0) {
  console.log(`OK ${pass}/${total}（市场索引：格式 1 规则镜像）`)
  process.exit(0)
}
console.log(`FAIL ${failures.length}/${total}`)
for (const f of failures) console.log(`  - ${f}`)
process.exit(1)
