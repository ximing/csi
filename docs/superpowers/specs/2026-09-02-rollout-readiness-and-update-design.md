# 推广就绪修复 + 手动/自动更新机制设计

日期:2026-09-02
状态:待用户审阅

## 背景

CSI 即将推广给更多用户。三路审查(daemon / extension / 分发链路)发现一批推广前必须处理的问题,且当前完全没有更新通道:daemon 无版本检查、无自更新;sideload 扩展永不自动更新;README 无升级/卸载章节;版本号多表面靠人工对齐且已实际脱节(插件清单停在 0.6.0)。

## 范围决策(用户已确认)

- **不做** HTTP Origin/Host 校验与任何形式的鉴权层:攻击面限于本地回环,接受现状(项目规则:loopback 即隔离边界)。
- **做** 发版修复、健壮性修复、更新机制(手动文档化 + daemon CLI 内建自动更新)。
- 崩溃自愈:不做 launchd `KeepAlive`,由每日定时更新任务顺带探活拉起(`csi start` 幂等),最坏情况服务中断不超过一个更新周期。

## 工作流 A:发版修复

### A1. release CI 强制测试

`.github/workflows/release.yml` 增加 `test` job,作为 `daemon`/`extension` 构建 job 的前置:

- daemon:`go test ./... -race`(linux runner)
- extension:`npm ci && npx vitest run`(覆盖率门禁已内建于 vitest.config.ts)

### A2. 版本经 ldflags 注入

- `daemon/internal/version/version.go`:`const Version` 改为 `var Version = "0.7.0"`(`-X` 注入要求 string var,值为开发期兜底)。
- `release.yml` 构建时:`-ldflags="-s -w -X csi/daemon/internal/version.Version=${GITHUB_REF_NAME#v}"`。
- 效果:代码版本与 tag 不可能再漂移;本地构建仍是 version.go 里的兜底值。

### A3. 版本表面对齐 + CI 守卫

当前 12 处版本表面,已脱节(0.6.0 vs 0.7.0):

| 表面 | 位置 |
|---|---|
| daemon | `daemon/internal/version/version.go` |
| 扩展 | `extension/manifest.json`、`extension/package.json`、`package-lock.json` |
| 技能 | `skills/csi/SKILL.md`、`skills/csi-e2e/SKILL.md` frontmatter |
| 插件清单 ×5 | `.claude-plugin/plugin.json`、`marketplace.json`、`.codex-plugin/`、`.cursor-plugin/`、`.kimi-plugin/` |
| 根 | `package.json` |

- 新增 `scripts/check-version-alignment.sh`(或 mjs):断言所有表面一致,输出逐项 diff。
- 挂进 `skill-ci.yml`(每次 PR 检查);先把脱节表面统一修到当前版本。
- `scripts/package-extension.sh` 增加 manifest 与 package.json 交叉校验。

### A4. 商店合规修复

- `extension/manifest.json` 移除零使用的 `activeTab` 权限。
- `store/review-notes.md` 删除对不存在文件 `tab-manager.ts` 的引用,activeTab 段落随权限删除一并移除;核对全文与当前实现一致。

## 工作流 B:健壮性修复

### B1. WS 写 deadline(daemon)

`internal/ws/hub.go` `writeJSON`:写前 `SetWriteDeadline(now + 15s)`,写超时断开连接(由 pong 看门狗同款清理路径处理)。15s 兼顾超大帧(消息上限内任意帧 15s 写完绰绰有余)。

### B2. session map 回收(daemon)

现状:`internal/session/session.go` 的 `map[string]*Session` 惰性创建、永不回收。

设计:**容量上限 + 闲置 TTL 双闸**,访问即续期:

- 上限 256 个 session;超出时淘汰最久未访问者(LRU)。
- 闲置 TTL 24h;采用惰性清扫:每次访问 session map 时顺带淘汰过期项,不新增 goroutine。
- session 名长度上限 128 字符,超限在 `server.go` 校验层返回 400。
- 回收无副作用:session 只持有 `_tabId` 映射,被回收后下次请求走正常新建流程(协议 §3.4 已有 stale_target 降级路径)。

### B3. 扩展 WS 断线立即重连(extension)

现状:close 后只等 reconcile alarm(下限 30s)。

设计:close 事件触发立即重连,失败按指数退避(1s → 2s → 5s → 10s,封顶 30s)自行调度;与现有 alarm reconcile 共存(alarm 作为兜底,重连成功后清退避状态)。daemon 主动拒绝(hello 被拒/被踢)时直接进入退避,不立即死循环。

### B4. 扩展消费 hello_ack 的 daemonVersion(extension)

- `ws-client.ts` 存下 hello_ack 的 `daemonVersion`。
- popup 增加一行显示 daemon 版本;两侧 semver major.minor 不一致时显示警告文案(不阻断使用,兼容闸仍在 daemon 侧)。
- i18n:补 `_locales/en` 与 `zh_CN` 文案。

### B5. 小修

- `scripts/install.sh:295` 日志文件名提示 `daemon.log` → `daemon-<date>.log`(ps1 同步检查)。
- `skills/csi/references/operations.md:47` 删除对不存在的 `uninstall` 命令的引用——由工作流 C 真正实现 `csi uninstall` 后,该引用改为指向真实命令。

## 工作流 C:更新机制

### C1. `csi update` 子命令(daemon CLI)

```
csi update                    # 检查并更新 daemon 自身到 latest
csi update --check            # 只检查,/status 同款信息
csi update --quiet            # 定时任务用:无输出,失败只写日志
csi update --with-skills      # 顺带更新技能包
csi update --with-extension   # 顺带更新 sideload 扩展 zip(覆盖 ~/.csi/extension,提示需手动 reload)
```

流程:

1. 查询 GitHub latest release(`GET /repos/ximing/csi/releases/latest`,结果缓存到 `~/.csi/update-check.json`,24h TTL,避免 rate limit)。
2. 已是最新 → 退出码 0,输出提示。
3. 下载对应平台 artifact + `checksums.txt`,**sha256 校验**(补上了安装器也缺的完整性校验)。
4. 替换二进制:
   - unix:tmp 下载 → 校验 → `chmod +x` → rename 覆盖(原子)。
   - Windows:运行中的 exe 不能覆盖,先 rename 现行为 `csi.exe.old`,再落新文件。
   - 上一代保留为 `csi.bak`(单代回滚)。
5. 正在运行的 daemon:替换后调用自身优雅重启逻辑(复用 `/restart` 路径);未运行则只替换文件。
6. Homebrew 安装的 daemon(二进制路径含 `Cellar`/`homebrew`):拒绝自更新,提示 `brew upgrade`。

### C2. `/status` 暴露更新信息

- `update_available: bool`、`latest_version: string`(有缓存时)。
- daemon 启动时异步触发一次检查(写缓存),不阻塞启动。
- 技能侧 `operations.md` 教学更新:出错排查时看一眼 `/status` 的 `update_available`,有新版就引导用户跑 `csi update`。

### C3. 定时自动更新(autostart 框架扩展)

`csi autostart on` 时,除现有登录自启项外,再注册一个**每日一次**的更新任务,命令为:

```
csi start          # 幂等探活,顺带解决崩溃自愈(最坏恢复时间 = 1 天)
csi update --quiet
```

平台实现:

| 平台 | 机制 |
|---|---|
| macOS | 第二个 launchd plist(`ai.csi.update.plist`),`StartCalendarInterval` 每日 |
| Linux | systemd user timer(`csi-update.timer` + oneshot service) |
| Windows | 任务计划(schtasks)每日触发 |

- `csi autostart off` 一并移除;`install.sh/ps1` 的 `--no-autostart` 语义不变(两者都不注册)。
- 更新时刻加随机 jitter(0–60 分钟),避免所有用户同一时刻打 GitHub。
- 失败只写日志,不打扰用户;下次周期重试。

### C4. 安装器升级语义修复

- `install.sh`:第 5 步由 `csi start` 改为"运行中则 `csi restart`,未运行则 `csi start`",确保重跑安装器后新二进制立即生效。
- `install.ps1`:替换运行中的 `csi.exe` 前先 `csi stop`,替换后再 `csi start`(绕过 Windows 文件锁)。
- 两端安装器下载后校验 `checksums.txt` 的 sha256。
- 安装完成落 `~/.csi/VERSION`(安装的版本号),供排查与将来审计。

### C5. `csi uninstall`

```
csi uninstall   # 停止 daemon → 移除自启与定时任务 → 删除 ~/.csi(二进制/日志/配置)
```

- 交互确认(管道场景 `-y` 跳过)。
- 技能目录(`~/.claude/skills/csi` 等)与 Chrome 扩展不删,输出引导用户手动删除的路径/链接。
- `operations.md` 的死引用改为指向此真实命令。

### C6. 文档

- `README.md` + `README.zh-CN.md` 新增两节:
  - **升级**:三条通道(curl 安装器重跑 / `csi update` / `brew upgrade`),说明各自适用范围;自动更新机制一句话说明(每日检查,可用 `csi autostart off` 关闭);sideload 扩展升级后要 reload,CWS 用户无感。
  - **卸载**:`csi uninstall` + 手动清理技能/扩展引导。
- `docs/` 不动 `protocol.md`(本次不改 WS 协议;`/status` 新字段是 HTTP 面,更新 `operations.md` 对应文档段)。

## 错误处理总原则

- 更新的每一步失败都可恢复:下载/校验失败不动现有二进制;替换失败留有 `.bak`;重启失败由定时任务下周期拉起。
- 网络错误一律静默重试(下周期),不因 GitHub 不可达影响正常使用。

## 测试

- daemon:`update` 包的下载/校验/替换/回滚逻辑单测(httptest 假 GitHub);session 回收(LRU 上限、TTL 过期、长度校验);WS 写 deadline;autostart 生成函数(纯字符串,沿用现有测试模式)。
- extension:重连退避调度(沿用 ws-client-reconnect.test.ts 的 fake 模式);hello_ack 版本存储与 popup 警告渲染。
- CI:版本对齐脚本在 skill-ci 跑通;release.yml 的 test job 先在本 PR 验证。

## 明确不做(YAGNI)

- HTTP 鉴权 / Origin 校验(用户决策,接受本地回环信任模型)。
- launchd `KeepAlive` 崩溃秒级自愈(每日探活已够)。
- 多代回滚、增量更新、代码签名/公证(后续需要再议)。
- 技能包自动更新(默认不动用户可能被本地改过的技能目录,`--with-skills` 手动触发)。
- 协议显式 version 字段。
