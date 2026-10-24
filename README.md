# BeforeWrite

**每次写盘之前，先把「上一版」留下来。**

一个 DSH（DeepSeek Harness）宿主插件。它坐在文件写入的那一步上，在内容被覆盖的**一瞬间之前**把旧内容取走存起来，然后给你三个动作：看历史、看差异、回滚。

> 项目名 **BeforeWrite**（前一版）。
> 插件注册的工具名是 `time_machine` —— 因为它干的事就是让你退回过去某一刻。

```
$ time_machine list
最近 6 条快照（共 19 条，新 → 旧）：
#19  2026-10-25 00:08:31  write    （当时还不存在）  G:\sklii\tm-final-check.txt
#18  2026-10-25 00:08:13  restore  147 B  G:\sklii\tm-after-restart.txt
#17  2026-10-25 00:08:09  edit     110 B  G:\sklii\tm-after-restart.txt

$ time_machine diff id=17
#17  2026-10-25 00:08:09  G:\sklii\tm-after-restart.txt
（旧 = 快照 / 新 = 现在）
─────────────────────────────
+2 行 / -1 行
@@ …
  重启后第一次写入：这一行的旧版本应该已经被自动存下来了。
- 第二行。第三行。
+ 这一行是被我故意改坏的内容。
+ 第二行没了。

$ time_machine restore id=17
已回滚 G:\sklii\tm-after-restart.txt
恢复到 #17 的状态，110 B，操作类型 update。
回滚前的版本也存了一份，需要反悔就再 restore 那个新编号。
```

---

## 它解决什么问题

让 agent 改代码、改配置、改文档，最贵的一次事故不是它写错了，而是**它把原来对的那版覆盖掉之后，你才发现**。

现成的兜底手段都有缺口：

| 手段 | 缺口 |
|---|---|
| git | 要么你已经 commit 过，要么改动还没进去；而且它只管仓库里的文件 |
| 编辑器 Undo | 只在自己那个窗口里有效，agent 是在你别的地方改的 |
| 回收站 | 处理删除，不处理覆盖；覆盖之后根本没有副本 |
| 备份软件 | 按小时/按天，快照粒度太粗，落到「哪一次改动」上对不上 |

BeforeWrite 补的正是这一格：**粒度 = 一次写入**。不是每小时一次，是每一次。

## 为什么这个位置的插件很少

DSH 插件生态里绝大多数插件都挂在 **Client UI 槽位**（侧边栏、面板、设置页）——它们只是给你多一个界面看。

BeforeWrite 挂在 **Host Event 的 waterfall** 上：`fs/write-intent`。这是在写盘动作真正发生之前的决策点，插件可以拿到「目标文件 + 即将被覆盖的旧内容」，也可以让这次写入带上前置条件。

区别是本质的：

- 面板插件：你主动去看它。
- waterfall 插件：它一直在，你看不见它，直到你需要它。

代价是这类钩子没有 UI 帮你验证。这个项目里两个最耗时间的坑（注册选项、模块缓存）都写在 [`docs/waterfall-notes.md`](docs/waterfall-notes.md) 里，包括完整的实测矩阵——如果你也要写 waterfall 插件，那一页能省你一晚上。

## 安装

前提：DSH 宿主（`dsh web`）在跑，`plugin_manager` 可用。

### 方式一：从本地目录装

```text
plugin_manager(action="install_bundle", target="G:\\path\\to\\beforewrite")
```

### 方式二：先 clone 再装

```powershell
git clone https://github.com/caishengshuo/beforewrite.git
```

然后对 clone 下来的目录做一次 `install_bundle`。

装完检查两件事：

1. 工具列表里出现 `time_machine`；
2. 默认存储目录 `~/.dsh/time-machine/` 被创建（里面有 `blobs/` 和 `index.jsonl`）。

> **如果装完没反应，99% 是模块缓存。** DSH 的插件模块按**包名**缓存：同一个包名重新安装不会重新加载 JS。改过代码就要改 `package.json` 里的 `name`（和 `cordis.patch.yml` 里的 `name`）再装一次。细节见 `docs/waterfall-notes.md`。

## 用法

六个动作，全部通过同一个工具 `time_machine` 调用。

| 动作 | 参数 | 干什么 |
|---|---|---|
| `list` | `limit`, `path` | 最近的快照，新 → 旧 |
| `history` | `path` | 某个文件的所有版本 |
| `diff` | `id` | 把这个快照和当前文件做行级对比 |
| `restore` | `id` | 回滚到该快照（回滚前那一版也会存下来，可以反悔） |
| `stats` | — | 仓库体量、去重后占用 |
| `snapshot` | `path`, `reason` | **手动**给文件打一份快照 |

### 自动与手动

前五个动作处理的是**自动快照**：任何经过 DSH 文件服务的写入或编辑，在内容被替换前自动留一份。

但 agent 有时会绕过文件服务直接动文件——`bash` 里的 `rm`、`sed -i`、`>` 重定向、`mv`。这一类不会触发 `write-intent`。所以在跑这种破坏性命令**之前**，用第六个动作手动打点：

```text
time_machine(action="snapshot", path="G:\\proj\\config.yaml", reason="before-bash-delete")
```

这是这个项目里唯一需要你（或 agent）有意识去做的动作，也是它的设计边界：**能拦的是代码路径，拦不住的是 shell**。

### 回滚不是撤销

`restore` 会把目标文件替换成快照的内容，同时**把替换前的当前内容也存一份**。

所以回滚本身是安全的：反悔就再 `restore` 一次那个新编号。快照链不会断，历史永远只增不减。

## 数据存在哪

```
~/.dsh/time-machine/
├── blobs/          内容寻址：文件内容按 sha256 存，同内容只存一次
│   └── ff/ff291730…   
└── index.jsonl     追加写的索引，一行一次改动
```

- 索引是 **JSON Lines**，追加写，不做原地更新——进程被 kill 也不会写坏。
- 内容块按 sha256 去重。改一个 5000 行的文件里的一个字符，新增的存储量是**一个内容块**，不是整个文件。
- 一份 `index.jsonl` 记录：时间、动作（write/edit/restore/snapshot）、路径、sha、字节数。
- diff 是现算的：从 blob 读旧内容，和磁盘读新内容做 LCS 行级对比，带上下各 3 行的裁剪。

默认上限：

| 参数 | 值 | 为什么 |
|---|---|---|
| 单文件 | 2 MiB | 再大就不是「手滑能救回来」的场景了，是二进制资源，该走别的路子 |
| 索引条数 | 20000 | 够覆盖一个长项目的改动史；超出后按旧到新淘汰 |
| 忽略路径 | `node_modules` / `.git` / `time-machine` | 存它们等于把仓库复制一遍，收益为零 |

## 目录结构

```
beforewrite/
├── index.js              插件本体（apply + 六个动作 + 工具注册）
├── package.json          dsh.bundle.patch 指向 patch 文件
├── cordis.patch.yml      insert 一行，把插件挂进 Host
├── locale/{zh,en}.json   插件管理器里显示的名字与描述
├── icon.svg              图标
├── smoke.mjs             离线冒烟测试（假 ctx，不碰真实运行时）
└── docs/waterfall-notes.md   waterfall 钩子的实测笔记
```

## 离线自测

`smoke.mjs` 用一个假的 `ctx` 和一个内存版 `fs` 服务跑完整流程，不依赖宿主：

```powershell
node smoke.mjs
```

它验证五件事：写入前快照 → 列表读取 → diff 内容正确 → restore 精确还原 → stats 计数。改动 `index.js` 后先跑它，再谈装进运行时。

## 局限（说清楚比藏着好）

1. **拦不住 shell**。`rm`、`sed -i`、重定向都不经过文件服务。需要手动 `snapshot`。
2. **只管文本**。二进制文件会被跳过或按字节存下来但无法 diff。
3. **没有远程同步**。仓库是本地的，换机器就没了。
4. **不改写历史**。索引只增不减（`list` 是读时截断），所以磁盘会慢慢长。
5. **工具名固定**为 `time_machine`，不随项目名变化——改名会动到已安装实例的工具注册，留到下一个大版本。

## 下一步（未做）

- **会话级回滚**：现在只能按文件退。理想是 `restore turn=<回合号>`，一次把某一轮对话里碰过的所有文件全退回去。
- **保留策略**：现在只有条数上限。改成「7 天内全留，之后每天留一条」，仓库不会无限长。
- **面板**：侧边栏一条时间轴，点一下回滚。唯一需要画界面的部分。

---

## English

**BeforeWrite** is a host plugin for [DSH](https://github.com/deepseek-ai) (DeepSeek Harness) that hooks `fs/write-intent` — the waterfall event that fires immediately before a file's contents are replaced — and stores the outgoing version in a content-addressed store before the write lands.

It then exposes one tool, `time_machine`, with six actions: `list`, `history`, `diff`, `restore`, `stats`, `snapshot`.

Why it is uncommon: almost every plugin in this ecosystem mounts a Client UI slot and gives you another panel. BeforeWrite mounts a Host waterfall and changes what happens, invisibly, at the moment that matters. There is no UI to reward you for it — which is exactly why the two hardest findings (the listener registration matrix and the package-name module cache) are documented in `docs/waterfall-notes.md`.

Everything the agent writes through the file service is captured automatically, one snapshot per write. Shell-level destruction (`rm`, `sed -i`, redirection) is out of reach and needs a manual `snapshot` call first.

MIT licensed.

---

## License

MIT © 2026 凉 ([@caishengshuo](https://github.com/caishengshuo))
