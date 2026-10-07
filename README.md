# 二维 Ising 显式提议序列回放后端

这是一个只包含 API 与 CLI 的 Windows 本地后端，用于回放二维 Ising 模型中调用方给定的翻转提议序列。程序不会调用系统随机数，也不会自行补提议；每一步使用调用方提供的 `u` 做 Metropolis 比较，因此相同棋盘、温度和提议顺序必然得到相同结果。

## 模型边界

- 格子为方形二维周期网格，边长 3 到 32；自旋只能是 `1` 或 `-1`。
- 每个自旋有上、下、左、右四个邻居，行列方向均周期环绕。
- 耦合常数固定为 `J = 1`，外场为 `0`。
- 总能量只对每格的右邻和下邻求和：`E = -Σ s[r,c]s[r,c+1] - Σ s[r,c]s[r+1,c]`。
- 磁化量是所有自旋的有符号总和。
- 翻转 `(r,c)` 前的局部能量差为 `ΔE = 2 s[r,c] (上+下+左+右)`。
- 接受规则：
  - `ΔE <= 0`：始终接受；
  - `ΔE > 0` 且 `T = 0`：拒绝；
  - `ΔE > 0` 且 `T > 0`：严格当 `u < exp(-ΔE / T)` 时接受。
- 每条提议的 `u` 都必须是有限数值且满足 `0 <= u < 1`，即使该步会无条件接受也会校验。
- 拒绝时棋盘、能量、磁化量不变，但拒绝仍是已处理步骤，版本加一。

本项目只核验小型有限网格的确定性提议回放，不计算临界温度、不拟合材料、不生成平衡分布、不绘制相图。

## 环境要求

- Windows 本地安装 Node.js 22 或更新版本；开发验证使用 Node.js `v25.5.0`。
- SQLite 使用 Node 内置的 `node:sqlite`（运行时会显示 experimental warning，不影响本项目同步事务逻辑）。
- 不需要 Docker、WSL、付费服务或外部在线 API。

## 安装、构建、测试、演示

```powershell
npm install
npm run build
npm test
npm run demo
```

启动 HTTP 服务：

```powershell
npm start
```

默认端口传 `0`，操作系统会选择空闲端口；启动日志会打印实际地址。也可以指定端口和数据库：

```powershell
$env:PORT="3000"
$env:ISING_DB="data/ising.sqlite"
npm start
```

## CLI

```powershell
node dist/cli.js serve --port 0

node dist/cli.js create --body '{"id":"demo","temperature":0,"grid":[[1,1,1],[1,1,1],[1,1,1]]}'

node dist/cli.js submit demo --body '{"requestId":"r1","expectedVersion":0,"temperature":0,"proposals":[{"id":"p1","row":1,"col":1,"u":0}]}'

node dist/cli.js get demo
node dist/cli.js inspect demo --body '{"row":1,"col":1,"temperature":2}'
node dist/cli.js step demo --step 1
node dist/cli.js verify demo
node dist/cli.js history demo --limit 50 --offset 0
node dist/cli.js replay demo --to 1
```

CLI 默认使用 `data/ising.sqlite`，可加 `--db path/to/file.sqlite`。

## HTTP API

### `GET /health`

健康检查。

### `POST /boards`

建立棋盘。请求体：

```json
{
  "id": "demo",
  "temperature": 0,
  "grid": [[1,1,1],[1,1,1],[1,1,1]]
}
```

`id` 可省略，省略时自动生成。返回初始网格、当前版本 `0`、能量和磁化量。

### `POST /boards/:boardId/proposals`

提交一批有序提议。整批先完整校验，任何越界、非法温度、非法 `u` 都会返回错误且不推进状态。

```json
{
  "requestId": "batch-1",
  "expectedVersion": 0,
  "temperature": 2,
  "proposals": [
    {"id": "p1", "row": 1, "col": 1, "u": 0.0001},
    {"id": "p2", "row": 1, "col": 1, "u": 0.99}
  ]
}
```

`requestId` 在同一棋盘内幂等：重复提交完全相同的请求会返回原结果且不新增步骤。相同 `requestId` 但内容不同返回 `409`。`expectedVersion` 必须等于当前版本，否则返回 `409`。

温度变化通过新试验请求表达；旧试验及其步骤仍保留，不覆盖历史。

### `GET /boards/:boardId`

查看当前棋盘、温度、版本、能量和磁化量。

### `POST /boards/:boardId/inspect`

查看当前棋盘上某格的四邻居、局部能量差和接受概率，不改变状态：

```json
{"row": 1, "col": 1, "temperature": 2}
```

`temperature` 可省略，省略时使用棋盘当前温度。

### `GET /boards/:boardId/steps/:versionAfter`

按版本号查看某一步，包括原始提议、四邻居、`ΔE`、概率、接受/拒绝原因以及该步后的能量和磁化量。

### `GET /boards/:boardId/history?limit=50&offset=0`

分页导出步骤历史。分页只改变返回范围，不改变处理结果。

### `GET /boards/:boardId/verify`

从当前棋盘独立全量重算能量和磁化量，并逐条重放增量记录。返回是否一致、版本计数和具体差异。

### `POST /boards/:boardId/replay`

从保存的初始棋盘和完整提议历史重新计算：

```json
{"toVersion": 3}
```

省略 `toVersion` 时回放到当前版本，并检查是否与当前保存棋盘一致。

## 持久化

SQLite 文件默认在项目内 `data/ising.sqlite`。主要表：

- `boards`：初始网格、当前网格、当前温度、当前版本；
- `trials`：请求编号、试验温度、期望版本、批次后版本、规范化载荷哈希和起始网格；
- `steps`：完整提议、稳定提议编号、批内序号、版本前后以及完整结果摘要。

每次提交在一个同步事务中写入试验、步骤并更新当前棋盘。失败会回滚，不做半次翻转。

## 错误码

- `INVALID_ARGUMENT`：参数结构、温度、棋盘、行列或 `u` 非法。
- `INVALID_JSON`：HTTP 请求体不是合法 JSON。
- `NOT_FOUND`：棋盘或步骤不存在，或接口不存在。
- `CONFLICT`：版本过期、幂等键内容冲突或其他资源冲突。
- `INTERNAL`：未预期内部错误。

## 示例：Windows PowerShell 请求

```powershell
$body = @{
  id = "demo"
  temperature = 0
  grid = @(
    @(1,1,1),
    @(1,1,1),
    @(1,1,1)
  )
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:<PORT>/boards" -Body $body -ContentType "application/json"
```

## 已知限制

- 仅支持边长 3 到 32 的方形网格，避免极小周期网格的邻居重复定义。
- 同步执行适合本项目规模；未实现多进程任务恢复或并发工作队列。
- Node `node:sqlite` 在当前 Node 版本仍带实验性警告；后续 Node 主版本可能调整 API。
