# Session model: workspace → project → session — design

日期:2026-07-23
状态:设计已确认,分阶段实现中

## 目标

把切换器的会话从「每 workspace 一条平铺 session 列表」升级为三层:

- **workspace**(最外层)— scratch / rkings / …
- **project** = 一个目录(= claude 的 cwd),新建默认 `~/<名字>`
- **session** = 一个 `~/.claude/projects/<cwd-slug>/<id>.jsonl`

顺 claude 原生结构(claude 本就按 cwd 目录分组存会话),不另造存储。

## 已确认的决策

1. **并发**:每个「打开」的 session 各自一个常驻 claude 进程(独立 tmux `cl-<id8>`),懒启动,可同时多个。(空闲回收后续再加。)
2. **范围/目录**:所有 workspace 通用;新建 project → `~/<名字>`。
3. **改名**:创建/fork 用 claude 原生 `--name`;事后改名靠切换器侧存 `~/.switcher/names.json`(`sid→显示名`)覆盖显示(claude 无事后改名 CLI)。
4. **main**:main = `$HOME` project 里最新的 session(若无则全局最新)—— 即点 workspace 默认进入的那条,**不可删**;其余可删(删=删 .jsonl + 杀其 tmux)。project 的最后一个 session 删掉后该 project 从列表消失。
5. **fork**:`claude --resume <id> --fork-session`,默认落在同 project(同 cwd)。

## claude 原生支持(已核实)

`--resume <id>` / `--fork-session` / `-c` / `--name <显示名>`。resume/fork/命名都调 CLI 即可。

## 后端

- **枚举(SESS_PY)**:每条 session 额外读出 `cwd`(取 transcript 记录里的 `cwd` 字段,准确;不靠 slug 反解)。返回 `[{id,title,n,mtime,cwd}]`。服务端按 cwd 分组成 project、标记 main、并入 `~/.switcher/names.json` 覆盖显示名。
- **每-session tmux 启动**(`buildClaudeCmd`,自包含,不依赖目标的 .start-claude.sh → 跨 workspace 通用):
  - open:`tmux new-session -A -s cl-<id8> "cd <cwd> && <trust/onboarding jq> && exec claude --resume <id> --dangerously-skip-permissions"`
  - create:`mkdir -p ~/<名> && … exec claude --name <名>`(新 tmux)
  - fork:`… exec claude --resume <id> --fork-session`
- `/api/pty`、`/api/chat` 都按 session 路由:pty attach 该 session 的 tmux;chat tail 该 session 的 .jsonl。
- **新接口**:`/api/session/create`、`/api/session/fork`、`/api/session/delete`(main 保护)、`/api/session/rename`。

## 前端

- 会话选择器 → **project → session 树**;每 session 显示名可编辑;顶部「＋」弹项目名输入(存在则并入);每 session 有 fork / 改名 / 删除(main 无删除)。

## 阶段

1. **后端枚举分组**(SESS_PY 出 cwd,服务端分组 + main 标记 + names 覆盖),向后兼容地加进 `sessions` 事件。← 先做
2. **每-session 启动模型**(buildClaudeCmd + pty/chat 按 session 路由)。
3. **create / fork / delete / rename 接口**。
4. **UI 树 + 各操作**。

每阶段部署 + 验证后再进下一阶段。
