# 技术记录（原 README 归档）

> 这些是开发与发布过程中的细节记录，从 README 里搬出来的，不是给使用者看的。
> 使用者请回看 [README.md](../README.md)。
# dsh-plugin-tiles · 插件方块

会话标题旁一排小方块：**一个方块 = 一个装过的插件**。

## 安装

依赖：DSH 0.2.1 及以上（`package.json` 里有 `dsh.bundle` 清单，所以能被 `dsh plugin add` 装）。

```sh
# 从 npm（推荐）
dsh plugin add dsh-plugin-tiles

# 或直接从 GitHub 的某个提交装（没发 npm 时用这条）
dsh plugin add git+https://github.com/zydxn77/dsh-plugin-tiles.git
```

装完**重启 DSH** —— 客户端插件没有热重载。

装在哪：profile 的 `node_modules` 里，`package.json` 的 `dsh.profile.bundles` 也要有 `dsh-plugin-tiles`，
两处都在才算真的装上了。手工装（`link:` / junction）见文末「装在哪」。

**要不要先开一个会话**：这个插件挂在 `conversation.session.header.actions` 槽位，
就是「创造模式」「N 个子智能体」那一排的位置 —— 没有会话时那一排不存在，所以看不到。

## 它长什么样

- **标题栏只摆 9 块**（`INLINE_TILES`），第 10 个起收进抽屉；抽屉入口是一个**常驻的 `▾`**
  （不再显示 `+N`，也不再只在超出时才出现 —— 抽屉里还有尺寸控件，全滤空时也要能打开）；
- 开 = **深色"键帽"**（竖向渐变 + 上沿内高光 + 细描边 + 极浅投影）；关 = 空心 + 虚线 + 更暗。
  角标（✓/×）按他要求去掉了，靠"实心/空心 + 实线/虚线 + 透明度"三层区分。
  配色集中在 `TILE_ON` / `TILE_OFF` 两个对象里，改那儿就行，别在 JSX 里散写颜色；
- 方块上写**整名**：宽度够就显示全，放不下用省略号（不是只显示一个字）；
  悬停看完整名字 + 包名 + 状态；
- 抽屉里一行一个，带勾选框，点行翻转；Esc / 点空白 / 点 × 关闭；
- **尺寸可调**（`大小` / `长短` 两个维度）：抽屉里一组滑块 + 数字框，
  或者鼠标停在方块行上滚轮调大小、`Shift+滚轮` 调长短；存 `localStorage`；
- **名字可改**：**右键**方块或抽屉行弹出改名卡（左键是开关）；存宿主侧，换浏览器不丢。

## 名字

**左键开关、右键改名**（2026-11-03 他定的，替代原来的 ✎ 按钮）。

右键方块、或右键抽屉里那一行，都会在鼠标位置弹一张改名卡：输入框 + `存` / `取消`
（Enter / Esc 也行）。留空 = 取消自定义、回到插件自己的标题。

存在**宿主侧**：`$DSH_HOME/plugin-tiles/names.json`，键是 **`moduleName`**（不是 `entryId`）——
entryId 是加载器条的 id（`include:xxx`），重装或改 patch 会变；模块名是包身份，稳定。
同一个模块有多条时会一起改名，那正是想要的。

改名**只影响这里显示**，不动插件本身；宿主在过滤之后才套名字，所以不会影响"系统自带"的判断。

## 尺寸

两个维度是独立的：

| | 管什么 | 范围 | 默认 |
|---|---|---|---|
| `size`（大小） | 高、字号、圆角 | 14–44 px | 24 |
| `width`（长短） | 宽 | 12–96 px | 跟着高 = 正方形 |

只改"大小"时，**如果宽原来等于高**（正方形），宽会跟着走 —— 否则拉一下高就变成扁方块。
改"长短"之后两者解耦，各走各的。

键盘/鼠标都能用：抽屉里有滑块 + 数字框（数字框能直接敲），行上滚轮是快捷方式。
`localStorage` 键 `dsh-plugin-tiles:view`，坏数据退回默认（`clampSize(null)` 那个坑修过了）。

## 它长在哪

槽位：`conversation.session.header.actions` —— 就是「创造模式」「N 个子智能体」
那一排的位置，紧挨着会话标题。所以**要先开一个会话**才看得见。

## 它改的是什么

不是另存一份状态。两边都是宿主 `pluginManager` 服务：

| 这里 | 等价于 |
|---|---|
| `GET /list` | `pluginManager.listPlugins()` |
| `POST /toggle` | `pluginManager.setPluginEnabled(id, enabled)` |

`plugin_manager` 工具、「设置 → 插件」页、这排方块，**动的是同一处**。

返回值里的 `application` 会如实显示：`applied`（已生效）/
`restart-required`（闪一句"重启后生效"）/ `failed`。

## 系统自带的怎么滤掉

`listPlugins()` 返回的是**全部加载器条目**，实测 `total: 202`，绝大多数是内核：

```
{ entryId: 'include:llm', moduleName: '@deepseek-ai/dsh-llm', enabled: true, ... }
```

判据用**模块名**：`moduleName` 以 `@deepseek-ai/` 开头、或等于 `cordis:include` 的都滤掉。
他装的是 `dsh-whale-desk` / `dsh-wcdb` / `@venshell/...` 这类，不会误伤。

⚠️ **第一版做错了**：按 `listBundles()` 里 `official: true` 的 `rows[].entryId` 去滤 ——
实测那些行**大多没有 `entryId`**（可选字段），一条都没滤掉，界面上冒出 `+186`。
bundle 那道判据现在只当第二道兜底。

## 它不肯关自己

关掉它就是关掉这排方块，等于把钥匙锁在门后。所以：

- 宿主侧硬拦：`POST /toggle { id: <自己>, enabled: false }` → `400 self-disable-refused`；
- 客户端也提前提示（方块 title 里会写）。

真要停它，走「设置 → 插件」。**这是故意的，不是 bug。**

## 排序

按标题稳定排序（中文按拼音）。**不按开关状态排**——点一下就重排的话，
手会在同一位置点到下一块，那是最难受的交互。

## 数据在哪

没有数据文件。列表 4 秒缓存（连着切页签别一直问宿主），开关之后立刻作废。
宿主的真实状态永远是真相源。

## 发到插件市场

仓库：<https://github.com/zydxn77/dsh-plugin-tiles>（公开）。

DSH 的「插件市场」不是中央服务器 —— `@deepseek-ai/dsh-plugin-market` 读的是**你配的一组 HTTP 索引 URL**。
所以发布 = ①发 npm 包 ②写一份索引 JSON 放 HTTPS 上 ③启用市场、把索引 URL 配进去。

### ① 发 npm 包

`package.json` 里 `private` 已经去掉，`author` / `repository` / `engines.dsh` 都补了。

```powershell
npm login
npm pack --dry-run     # 先看会打进去哪些文件
npm publish            # 带 scope 的包要 --access public
```

现在打出来是 **9 个文件 / 26.2 kB**：`README.md`、`cordis.patch.yml`、`icon.svg`、
`lib/{client,index,names}.js`、`locale/{en,zh}.json`、`package.json`。
`tests/` 和 `index.json` **不进包**（后者是给托管用的）。

> `npm pack` 如果报 `error writing to ...npm-cache`，是沙箱拦了缓存目录，
> 加 `--cache .\.npm-cache` 指到工作区里就行（跑完记得删）。

### ② 索引 JSON

`index.json` 已经备好，**和 `icon.svg` 放在同一个 HTTPS 目录**上传即可
（`icon` 是相对路径，会相对索引 URL 解析；跨域只能用 https）。

### ③ 启用市场

当前 profile 里这个 bundle 是 `optional`、**未安装**，所以看不到 Discover 页：

```powershell
# 用插件管理器装
install_bundle @deepseek-ai/dsh-plugin-market@0.2.1-rc.5
```

再给行 `plugin-market` 配索引：

```yaml
- id: plugin-market
  name: "@deepseek-ai/dsh-plugin-market"
  config:
    indexes:
      - https://你的域名/index.json
```

重启 DSH → 插件页出现 **Discover** 标签。

**索引格式 1 的硬规则**（抄自 `dsh-plugin-market-index` 的校验器，`tests/index.selftest.mjs` 逐条对着测）：

| 规则 | 要点 |
|---|---|
| `format` | 必须是数字 `1` |
| 顶层 `title` | **必填**，本地化对象，**必须含 `en`** |
| `plugins[].name` | 合法 npm 包名，同一索引内不重复 |
| `versions` | 非空；`version` 是**精确 SemVer**（不能 `^1.0.0`） |
| `publishTimestamp` | **Unix 秒**（不是毫秒），整数，< 10¹¹ |
| `source.type` | 只有 `npm`（可带 `registry`）或 `git`（`url` + 40 位小写 commit，可带 `path`） |
| `icon` | 相对路径必须解析到 https 或与索引同源；内联 `data:` ≤ 32 KiB |
| 未知字段 | **静默丢弃**，不报错 —— 字段名拼错不会提醒你 |

## 自检

```powershell
node tests\index.selftest.mjs     # 14 项：市场索引格式 1 的规则（校验器镜像）
node tests\names.selftest.mjs     # 10 项：自定义名字的清洗 / 落盘 / 套用
node tests\host.selftest.mjs      # 33 项：路由 + 过滤（availability / 只读）+ 排序 + 自关拦截 + 改名 + 信任栅栏
node tests\client.selftest.mjs    # 35 项：槽位、hook 顺序、9 块上限、抽屉、尺寸、右键改名、真渲染
```

共 **92 项**。验过不是空的：

- 把「开=实线 / 关=虚线」改成永远实线 → 报「关应当是虚线」；
- 把 `INLINE_TILES` 从 9 改成 12 → 报「他定的是 9 个，实际 12」；
- 把方块宽写成 `size` → 报「宽 = 长短 期望 72，实际 40」；
- 把过滤规则注回"永远按模块名"→ 报「用户装的官方插件要留住」；
- 把滚轮只读 `deltaY` → 报「Shift+滚轮只给 deltaX 期望 40，实际 0」；
- 把改名的 `invalidate()` 拿掉 → 报「标题要换 期望「阿鲸」，实际「小鲸鱼交互台」」；
- 把方块的 `onContextMenu` 拿掉 → 报「方块要挂 onContextMenu」；
- 把方块里的 `item.title` 换回 `item.initial` → 报「方块上写全名 期望 ["小鲸鱼交互台",…]，实际 ["小","灵","插"]」；
- 把展开键改回「只在超出 9 个时才显示」→ 报「只有 3 个插件时也要有 ▾」；
- 把"开"的底色换回饱和琥珀 → 报「开应当是质感渐变：rgb(232,178,58)」；
- 把 `publishTimestamp` 写成毫秒 → 报「越界（要 Unix 秒）」。

## 推 GitHub 的一个坑

`git push`（SSH 传输）在受限沙箱里会直接崩：

```
ssh.exe: *** fatal error - couldn't create signal pipe, Win32 error 5
fatal: Could not read from remote repository.
```

**不是权限问题，也不是仓库不存在** —— 是 MSYS 的 `ssh.exe` 建不了那张信号管道。
`git init` / `add` / `commit` / `log` 这些纯本地操作都正常，只有**过网的传输**会被拦。
推的时候要放宽沙箱（`danger-full-access`）跑那一条 `git push`。

客户端那 35 项里 **12 项是真渲染**（不是 grep 源码）：靠 `__testList` 往组件里
塞假列表（只在 `window.__DESK_TEST__ === true` 时生效，生产走不到），
然后断言方块数量、每块上的字、有没有角标、键帽还是空心、宽高与字号、
`▾` 截断、抽屉里是否列出全部、两个尺寸滑块的值、右键改名、点方块是否真的 POST 了取反后的状态。

## 投稿给社区市场

`contrib/zydxn77__dsh-plugin-tiles.yml` 是要提交给
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的条目文件，
放进那个仓库的 `data/plugins/` 再开 PR（规则见它的 `contributing.md`）。

准入条件（2026-11-03 对着原文核过）：

| 条件 | 本仓库 |
|---|---|
| 公开仓库 | ✅ `zydxn77/dsh-plugin-tiles` |
| `package.json` 有 `dsh.bundle` | ✅ 只有 `dsh.client` 是被拒的最常见原因 |
| 真实可用的代码 | ✅ `lib/` 三个文件 + 92 项自检 |
| 仓库创建满 **1 天** | ⏳ 2026-11-03 建，第二天才能提 |
| 仓库带 `dsh-plugin` topic | ✅ 已加 |
| README 有安装说明 | ✅ 开头「安装」一节 |
| 开源许可证（SPDX） | ✅ MIT（`LICENSE` + `package.json.license`） |

## 踩过的坑

**「系统自带」不能按 `official`、也不能按 `@deepseek-ai/` 前缀判。**
实测 `dsh-base` / `dsh-web-app` 的 `official` 是 **false**，而
`@deepseek-ai/dsh-experimental-agent-team-profile` 是 **true**；反过来按 scope 前缀又会
误杀用户装的官方插件。真正的判据是 `BundleInfo.availability === 'installation'`
（安装包自带）对 `'profile'`（装进 profile 的）。模块名前缀只留作拿不到 bundle 数据时的兜底。

**`Number(null)` 是 0。** `clampSize(null)` 会把它夹到**最小值**，于是"默认 24"
静默变成"最小 14"。尺寸这类"没给就用默认"的地方，`null` / `''` 必须当缺失处理 ——
这条是被自检抓出来的，不是想出来的。

**`findFirst` 必须摊平数组。** 渲染树里方块是 `map` 出来的数组，只递归 `children`
会一个都找不到——第一版测试就是这么全红的（不是组件错）。

**注册时传进去的 `t` 会覆盖测试桩。** 组件里的 `t` 来自 `apply()` 那份翻译器，
测试里传 `t: (k) => k` 没用，断言里得用真中文。

**错误边界要放在这个槽里。** 渲染期抛错会被 slot 判成 `active:false`，
界面上什么都不出现也没有提示（鲸鱼那边踩过一次）；有边界才会把错画在屏幕上。

**抽屉要用 `position: fixed`，且是行的兄弟节点。** 塞进行里会被
`overflowX: auto` 裁掉。

## 装在哪

profile 里是**手工挂载**的（`Junction` → 本目录），因为
`dsh-plugin-grill-me` 的 tarball 已经不在了，任何 `pnpm install` 都会失败。见 `~/.dsh/AGENTS.md`。

