# dsh-plugin-tiles · 插件方块

会话标题旁一排小方块：**一个方块 = 一个装过的插件**。左键开关，右键改名，尺寸可调。

## 安装

需要 DSH 0.2.1 及以上。

```sh
dsh plugin add dsh-plugin-tiles
```

还没发 npm 的话，直接从仓库装：

```sh
dsh plugin add git+https://github.com/zydxn77/dsh-plugin-tiles.git
```

装完**重启 DSH** —— 客户端插件没有热重载。然后**开一个会话**：这排长在会话标题栏上，
没有会话就没有那一栏，也就看不到它。

## 使用

| 操作 | 效果 |
|---|---|
| **左键**方块 | 开 / 关这个插件 |
| **右键**方块或抽屉里的行 | 改名（留空 = 用原名） |
| 点末尾的 **`▾`** | 打开抽屉：全部插件 + 尺寸滑块 |
| 鼠标停在方块上滚轮 | 调大小（14–44） |
| `Shift` + 滚轮 | 调长短（宽度 12–96） |
| 悬停 | 看完整名字、包名、当前状态 |

- 标题栏只摆 **9 块**，其余收进 `▾` 抽屉；
- **开** = 深色键帽（渐变 + 高光 + 细边），**关** = 空心 + 虚线 + 更暗；
- 方块上写整名，放不下用省略号；
- 尺寸和名字都记得住：尺寸存浏览器（`localStorage`），名字存宿主
  （`$DSH_HOME/plugin-tiles/names.json`），换浏览器不丢。

## 它不显示什么

- **DSH 自带的插件** —— 那些不该在这排里开关；
- **改不了的条目**（`readOnlyReason` 非空）—— 点了也没用；
- **它自己**不能关自己（关掉这排就没了），要关请走「设置 → 插件」。

## 开发

```sh
node tests/index.selftest.mjs     # 14 项：市场索引格式
node tests/names.selftest.mjs     # 10 项：自定义名字
node tests/host.selftest.mjs      # 33 项：路由 + 过滤 + 自关拦截
node tests/client.selftest.mjs    # 35 项：真渲染
```

判断依据、踩过的坑、发布到市场的流程，都在 [docs/NOTES.md](docs/NOTES.md)。

## 许可

MIT
