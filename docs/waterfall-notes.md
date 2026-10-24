# waterfall 钩子实测笔记

写这个插件时踩的两个坑，都是「代码看起来完全正确、运行时静默不工作」。留档，省下别人的一晚。

环境：DSH `dsh web`，Windows 11，Node ESM。

---

## 坑一：注册选项不是可选的

`fs/write-intent` 是 waterfall 事件。按常理，`ctx.on('fs/write-intent', fn)` 就该收到。实际不会——**一行都不执行**，没有任何报错。

实测矩阵（五种写法，同一个插件里同时挂，各写一行日志）：

| 注册写法 | 是否收到 `fs/write-intent` |
|---|---|
| `ctx.on(name, fn)` | ✗ |
| `ctx.on(name, fn, true)` | ✗ |
| `ctx.on(name, fn, { prepend: true })` | ✗ |
| `ctx.on(name, fn, { global: true })` | ✗ |
| `ctx.on(name, fn, { global: true, prepend: true })` | ✓ |

对照组：同一个插件里 `ctx.on('fs/observed', fn)`（emit 事件）**普通注册就能收到**。所以不是插件没加载、不是 ctx 不对、不是事件名拼错——是 waterfall 的派发方只认同时带 `global` 和 `prepend` 的监听器。

### 怎么确认事件真的发生了

在怀疑自己之前，先确认上游有没有派发。注册一个只在观测层用的事件：

```js
ctx.on('internal/dispatch', (mode, eventName, args) => {
    if (eventName === 'fs/write-intent') console.log('dispatched', mode, args?.[0])
}, { global: true })
```

`internal/dispatch` 是全局的派发探针，`{ global: true }` 就够。看到 `mode=waterfall event=fs/write-intent` 打出来，就说明事件确实在走，问题一定在监听侧。

### 别忘了 `next()`

`fs/write-intent` 是 **single-slot decision**：第一个返回 intent 的监听器拥有这次写入的决策权，后面的同伴不参与组合。

所以监听器必须把 `next()` 传下去：

```js
ctx.on('fs/write-intent', async (target, actor, next) => {
    await capture(target)      // 先取旧内容
    return next()              // 再把决定权交还后面的链
}, { global: true, prepend: true })
```

直接 `return undefined` 不是「没意见」，而是**替所有人做了「无条件写」的决定**——你会静默顶掉上游的守卫（比如官方的破甲/观察策略）。

`prepend: true` 在这里还有额外意义：你要在**别人决定写之前**看到旧内容，所以必须排在链首。

---

## 坑二：模块缓存按包名

改完 `index.js`，重新 `install_bundle`，行为一点没变。逐项排除：

| 尝试 | 结果 |
|---|---|
| `remove_bundle` 后对**同一路径**重装 | 旧代码继续跑 |
| 换成**新目录**、保持同包名 | 旧代码继续跑 |
| 改 `exports` / 改 `files` | 无效 |
| 换成**新包名** | 立即加载新代码 |

结论：**DSH 的插件模块以包名为键缓存**。任何代码改动都要换 `package.json` 的 `name`（以及 `cordis.patch.yml` 里 insert 的 `name`）再装一次。

开发期的代价是插件名字会变成一串：`-v2`、`-v3`、`-final`。这是正常现象，不是设计缺陷——只是没人告诉过你。

### 附带结论

- `remove_bundle` 返回 `bundle-in-use` = 该 bundle 正在运行 / 挂在 fiber 上。**已挂载的删不掉，未挂载的能删。**
- `set_bundle enabled=false` 只改启用状态，**不重新加载模块**，也不重新读取 bundle 自带的 `cordis.patch.yml`。
- 运行中的宿主里，**新增** patch id 不会热挂载；沿用**已存在**的 patch id 才能顶替旧行。
- 所以升级流程是：改包名 → 装新的 → 旧的自然失效 → 再清理旧的。

---

## 顺带记一个 PowerShell 的坑

在 Windows 上用 `Set-Content -Encoding utf8`（PS 5.1）改 `package.json`，会写入 BOM；再 `Get-Content -Raw | ConvertFrom-Json` 会因为 BOM 与 ANSI 解码把中文字段读成乱码，报：

```
Invalid object passed in, ':' or '}' expected. (185)
```

然后把文件写成一整个 `null`。

**改 JSON 一律用支持 UTF-8 无 BOM 的工具**（编辑器 / Node 脚本），不要用 PowerShell 序列化往返。
