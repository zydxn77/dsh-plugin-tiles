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


## 使用

| 操作 | 效果 |
|---|---|
| **左键**方块 | 开 / 关这个插件 |
| **右键**方块或抽屉里的行 | 改名（留空 = 用原名） |
| 点末尾的 **`▾`** | 打开抽屉：全部插件 + 尺寸滑块 + 「全部静音」 |
| 抽屉里的 **`全部静音`** | 关掉所有开着的第三方插件，记下当时开着哪些；再点一下只把这些开回来 |
| 鼠标停在方块上滚轮 | 调大小（14–44） |
| `Shift` + 滚轮 | 调长短（宽度 12–96） |
| 悬停 | 看完整名字、包名、当前状态 |


## 卸载

```sh
dsh plugin remove dsh-plugin-tiles
```

## 开发

```sh
node tests/index.selftest.mjs     # 14 项：市场索引格式
node tests/names.selftest.mjs     # 10 项：自定义名字
node tests/host.selftest.mjs      # 33 项：路由 + 过滤 + 自关拦截
node tests/client.selftest.mjs    # 35 项：真渲染
```


## 许可

MIT
