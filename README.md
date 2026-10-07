# 二维 Ising 给定提议序列回放后端

一个**只做后端**的小型服务：给定初始棋盘、温度和一条**显式、有序**的翻转提议序列，
按 Metropolis 规则逐条回放，输出每一步是否接受、局部能量差、接受概率以及全局能量与磁化量。

技术栈：TypeScript + Node.js（内置 `node:sqlite`，**零运行时第三方依赖**，无需 C++ 编译）。
运行形态：仅 HTTP API 与 CLI，无前端、无 Docker、无 WSL、不依赖任何外部在线服务。

## 这个项目是什么 / 不是什么

- **是**：对用户给定提议序列的确定性回放与状态核验工具。每一步的随机比较值 `u` 由调用方显式提供。
- **不是**：蒙特卡洛模拟器。它**不**调用系统随机数、**不**做热化采样、**不**计算临界温度、
  **不**拟合真实材料、**不**生成平衡分布，也**不**绘制相图。

显式提议序列的意义：相同的初始棋盘、温度与提议顺序（含相同的 `u`）必然产生完全相同的结果，
便于复现、审计和教学核验；服务端绝不替换或自行生成随机数。

## 模型定义与边界

- 格子自旋只取 `+1` 或 `-1`；行列数 `rows`、`cols` 均满足 `3 <= n <= 32`。
  限制至少为 3，是为避免 1x1、2x2 等周期网格中"邻居彼此重合"的特殊定义。
- 四邻居（上、下、左、右），周期边界（环绕）。
- 耦合常数固定 `J = 1`，外场 `h = 0`。
- 总能量（每格只计右邻与下邻，键不重复计两遍）：

  `E = -Σ_{r,c} [ S(r,c)·S(r,c+1) + S(r,c)·S(r+1,c) ]`（下标取模）

- 磁化量为所有自旋的有符号总和 `M = Σ S(r,c)`。
- 翻转 `(r,c)` 前的**局部能量差**：`ΔE = 2 · S(r,c) · (S_up + S_down + S_left + S_right)`。
- Metropolis 接受规则（严格 `<`，不是 `<=`）：
  - `ΔE <= 0`：始终接受；
  - `ΔE > 0` 且 `T > 0`：当且仅当 `u < exp(-ΔE / T)` 时接受；
  - `T = 0`：拒绝所有正能量差。
- 每条提议必须带 `u`，且为有限数值、`0 <= u < 1`。**即使该步会无条件接受（ΔE<=0）也照样校验**。
- 温度必须为 `>= 0` 的有限数值，**负温报错**。
- 被拒绝时棋盘、能量、磁化量完全不变，但该提议仍计为已处理的一步。
- 一个**批次**（一次提交的多条提议）在执行前整体校验；任一条越界或非法，则整批不推进、不部分写入。
- 温度变化不覆盖旧试验，而是通过"从保存起点回放并另存为新试验记录"表达。

## 环境要求

- Windows 本地安装 **Node.js >= 22.5**（内置 `node:sqlite`；开发与验证使用 v25.5.0）。
- 安装依赖（仅 TypeScript / tsx / 类型声明，均为开发依赖）：

```powershell
npm install
```

## 常用命令（PowerShell）

```powershell
npm run build     # 类型检查并编译到 dist/
npm test          # 运行全部 23 个单元/集成/HTTP 测试（tsx + node:test）
npm run demo      # 内置演示：正温接受、零温拒绝、翻回、核验、幂等、温度另存
npm start         # 等价 node dist/cli.js serve；自动选择空闲端口
npm run cli -- serve --port 8080          # 指定端口（被占用则回退到空闲端口）
$env:ISING_DB="data/x.sqlite"; npm start  # 自定义数据库路径（默认 data/ising.sqlite）
node dist/cli.js init-db                  # 仅初始化数据库
node dist/cli.js selftest                 # CLI 冒烟自检
```

启动成功后控制台输出一段 JSON，含实际监听端口与健康检查地址，例如：

```json
{ "status": "listening", "host": "127.0.0.1", "port": 54743, "db": "...\\data\\ising.sqlite" }
```

## HTTP API

所有请求/响应均为 JSON。错误响应形如
`{ "error": { "code": "OUT_OF_BOUNDS", "message": "..." } }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/experiments` | 列出全部试验 |
| POST | `/api/experiments` | 建立棋盘：`{ name?, grid, temperature }` |
| GET | `/api/experiments/:id` | 查询当前棋盘、能量、磁化量、版本 |
| POST | `/api/experiments/:id/proposals` | 提交一批提议（事务、幂等、版本校验） |
| GET | `/api/experiments/:id/steps/:g/inspect` | 查看第 `g` 个全局步骤的邻居、ΔE、概率 |
| GET | `/api/experiments/:id/steps/:g/inspect?row=&col=` | 查看**当前棋盘**某格的即时邻居与概率（不改变状态） |
| GET | `/api/experiments/:id/verify` | 从当前棋盘独立重算 E/M，与增量记录比对 |
| GET | `/api/experiments/:id/history?limit=&offset=` | 分页导出批次与逐步历史 |
| POST | `/api/experiments/:id/replay` | 从保存起点不落库回放；可给新温度并 `saveAs` 另存新试验 |

### 提交提议

```json
POST /api/experiments/1/proposals
{
  "requestId": "req-001",
  "baseVersion": 0,
  "proposals": [
    { "row": 0, "col": 0, "u": 0.0001 },
    { "row": 0, "col": 0, "u": 0.99 }
  ]
}
```

- `requestId`：稳定的客户端请求编号，用于幂等。重复提交相同 `requestId` 与相同内容返回原结果（HTTP 200，`idempotent:true`），不产生新版本；相同 `requestId` 但内容不同返回 409。
- `baseVersion`：客户端所依据的版本（省略时默认取当前版本）。在旧版本上提交返回 409 `VERSION_CONFLICT`，不写入。
- 响应包含每个步骤的邻居、邻居和、`deltaE`、`acceptProbability`（ΔE<=0 为 `1`，零温不利为 `0`，否则为指数值）、`accepted` 以及前后 E/M。

### 从保存起点回放 / 温度变化

```json
POST /api/experiments/1/replay
{ "temperature": 1.0, "proposals": [ { "row": 0, "col": 0, "u": 0.01 } ], "saveAs": true, "name": "T1 分支" }
```

不传 `temperature` 时沿用原温度；`saveAs:true` 时把回放结果棋盘作为初始网格另存为一条**新试验记录**
（新版本从 0 开始），原试验及其温度、历史保持不变。

## 错误码

| code | 含义 |
| --- | --- |
| `INVALID_JSON` | 请求体不是合法 JSON |
| `INVALID_DIMENSIONS` | rows/cols 非整数或超出 [3,32] |
| `INVALID_GRID` / `INVALID_SPIN` | 网格结构错误 / 自旋不是 ±1 |
| `INVALID_TEMPERATURE` | 温度非有限值或为负 |
| `INVALID_PROPOSAL` / `OUT_OF_BOUNDS` | 提议结构错误 / 行列越界 |
| `INVALID_U` | `u` 非有限值或不满足 0 <= u < 1 |
| `INVALID_PAGINATION` | limit/offset 非法 |
| `NOT_FOUND` | 试验或步骤不存在（404） |
| `VERSION_CONFLICT` | 基于过期版本提交（409） |
| `REQUEST_ID_REPLAY` | requestId 已用于不同内容（409） |
| `METHOD_NOT_ALLOWED` | 方法不允许（405） |
| `BAD_REQUEST` | 其他请求错误 |

## 持久化

- SQLite 数据库默认位于项目内 `data/ising.sqlite`（首次运行自动创建目录与表，WAL 模式）。
- 三张表：`experiments`（初始网格、温度、当前网格、当前 E/M、版本）、
  `batches`（请求编号、基线/新版本、完整提议 JSON、结果摘要）、
  `steps`（每一步的邻居、ΔE、概率、决策、前后 E/M、全局步骤号）。
- 一次成功提交在**单个事务**内写入新棋盘、新版本与全部步骤摘要；任务规模小，采用同步执行，
  不实现"半次翻转"的跨进程恢复。

## 标准算例（已在测试与演示中断言）

3x3 全 `+1` 周期网格：

- 初始 `E = -18`、`M = 9`；
- 翻转任一格 `ΔE = 8`；接受后 `E = -10`、`M = 7`；
- 零温时该不利翻转被拒绝（状态不变）；正温且 `u` 足够小时接受；再翻回该格 `ΔE = -8` 无条件接受。

测试还覆盖：边角周期环绕、`ΔE = 0`、负温拒绝、概率严格边界（`u` 恰等于概率时拒绝）、
重复翻同格、多步回放计数、对 3x3 至 32x32 逐格用全量重算能量核对局部公式、
失败批次不落地、重复请求幂等、旧版本冲突与真实 HTTP 流程。

## 限制

- 仅后端；没有图形界面或相图输出。
- 同步处理，面向教学/小规模核验（最大 32x32），未做并发吞吐优化。
- `node:sqlite` 在当前 Node 版本带有一条实验性警告，不影响功能。
