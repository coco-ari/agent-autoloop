# 中心接入 Worker

本包包含固定版本原生 Worker，与中心配套使用。需要 Node.js 24 或以上、Git，以及本机已经登录的 Codex 或 Claude Code。安装不替你登录模型，也不修改本机 Skill、MCP。

1. 解压源码包，在包目录执行 `npm ci`。依赖已由 package-lock.json 固定；运行程序仍使用本机安装版本。
2. 从中心“系统设置 → 任务服务 → 接入执行节点”下载 `worker-connection.json`。
3. 新建只供这个 Worker 使用的数据目录，将下载文件保存为其中的 `config.json`。在 `worker.roots` 数组中填写明确允许的绝对路径，例如 `["D:/agent-projects"]`。只把准备参与任务的 Git 仓库放在这些目录或其直接子目录中；任务根路径应选仓库之外的另一子目录。
4. 将环境变量 `AGENT_AUTOLOOP_HOME` 设置为该数据目录，运行 `node bin/agent-autoloop.ts up`。需要后台运行时沿用本包原生服务管理说明，不使用另一套守护程序。
5. 中心显示节点在线和目录报告后，在项目设置选择已检测仓库。若模型未就绪，先在执行电脑修复运行程序或登录，再等待报告刷新。

例如 PowerShell 中设置 `$env:AGENT_AUTOLOOP_HOME = 'D:/agent-worker-data'`；Linux 中使用 `export AGENT_AUTOLOOP_HOME=/srv/agent-worker-data`。随后从本包目录运行上述 up 命令。

配置中的 `url` 必须是执行电脑可访问的 Hub 地址，不能使用仅中心容器可解析的名字。接入凭据为长期专用密钥，撤销前有效。不要把配置提交到仓库或公开分享。中心不显示已接入节点的明文密钥，丢失时先清理引用任务与配置，再撤销并重新接入。

本次目录能力使用 Git worktree 隔离每个任务尝试。审核读取固定候选的只读差异快照；测试使用管理员配置的实际命令。停止核实进程结束后才完成，删除要等待所属 worktree 清理；原始仓库及模型账号不会删除。不同用户共享同一 Worker 的风险与本机权限由节点维护者管理。
