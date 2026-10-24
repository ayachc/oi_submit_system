# 信息学竞赛考试提交系统

根据参考截图制作的简洁版本，采用原生 HTML、CSS、JavaScript 和 Node.js 标准库，无需安装第三方依赖或配置数据库。

## 启动

安装 Node.js 20 或更新版本，在项目目录运行：

```powershell
npm start
```

保持服务运行，打开 <http://localhost:3000>，使用预设考号登录：

- 用户名：`LN-0001` 至 `LN-0999`，共 999 个账号（大写 `LN`，数字补齐四位）
- 密码：统一为 `abc123`

例如：`LN-0001` / `abc123`。所有账号启动后即可使用，无需手工注册；每个账号拥有独立的提交记录。

开发时可运行 `npm run dev`，修改服务端文件后自动重启。

## 页面与功能

- 登录页：白色顶栏、浅灰背景、居中登录卡片，校验用户名和密码格式。
- 考试页：考生信息与考试流程卡片、考试状态、a/b/c/d 四张提交卡片。
- 试题下载：当前内容为用户提供的 CSP-J 2021 `problem.zip`，网站下载文件名为 `day1.zip`。
- 源代码提交：支持 `.cpp`、`.cc`、`.cxx`、`.c`、`.py`、`.java`、`.pas`，自动识别 UTF-8（含 BOM）、GBK/GB18030（简体中文 Windows 的常见 ANSI 编码）和带 BOM 的 UTF-16。提交时统一转为 UTF-8，原文件及转换后的内容均不超过 1 MB，无需手工另存编码。
- 提交结果：显示文件名、大小和北京时间，可再次提交替换，并在弹窗中查看最后一次成功提交的代码。
- 账户菜单：点击右上角考号旁的设置按钮退出登录；页面适配桌面和手机。

系统支持多个考号同时登录，各账号只能查看和覆盖自己的提交；不提供自助注册、管理后台、编译或自动判题。登录会话最长 8 小时，服务重启后需重新登录，已保存的提交仍然保留。

## 配置

编辑 `config.mjs` 可以修改考试名称以及共用的考生展示信息（姓名、学校、年级和考场）；考号由登录账号自动填充。`accountConfig` 控制账号前缀、起止编号及统一密码。`examConfig.problems` 控制题目卡片；`status: 'ongoing'` 时允许提交，改为 `'ended'` 后停止接受新提交。更改配置后重启服务。

环境变量可配置监听地址，例如在 PowerShell 中运行：

```powershell
$env:HOST = 'localhost'
$env:PORT = '3000'
npm start
```

用户名须为 4–20 位字母、数字或连字符，密码须为 6–32 位字符。旧的 `OI_USERNAME` / `OI_PASSWORD` 环境变量已不再使用。默认仅监听本机；需要局域网访问时可将 `HOST` 设为 `0.0.0.0`，其他设备通过服务器的局域网 IP 和端口 `3000` 访问。

打开网页前需确认终端已显示启动地址。启动后的终端应保持运行；关闭终端或按 `Ctrl+C` 会停止服务。若提示端口占用，可设置其他 `PORT` 后重新启动，并使用对应端口访问。

用自己的 ZIP 文件替换 `public/exam/day1.zip` 即可更换试题包，下载时立即生效。如果压缩包已加密，可在 `config.mjs` 中填写 `examConfig.password`，用于向已登录考生显示解压密码；该配置本身不会给 ZIP 加密。以下命令需要 Python 3，会将当前试题包覆盖为自编示例包：

```powershell
python scripts/create-sample-exam.py
```

## 文件与数据

```text
config.mjs                     考试、999 个预设账号及考生展示配置
server.mjs                     登录、下载、提交和持久化接口
public/index.html              登录页、考试页与弹窗
public/styles.css              布局与样式
public/app.js                  页面交互
public/source-file.js          Windows 常见源码编码兼容
public/exam/day1.zip           当前考试试题包
scripts/create-sample-exam.py  示例包生成脚本
tests/server.test.mjs          后端集成测试
tests/source-file.test.mjs     文件编码与读取回归测试
data/                         运行后创建的提交数据目录
```

提交以 JSON 保存到 `data/<用户名的 SHA-256>/<题号>.json`，包含源代码和提交信息，每道题保留最新版本。该目录已加入 `.gitignore`；备份提交时请备份整个 `data/`。账号变更后数据按用户名隔离。

## 检查

```powershell
npm test
npm run check
```

测试覆盖预设账号登录、登录退出、请求与文件校验、提交替换、代码读取、重启后数据保留、同一服务中账号数据隔离、试题下载和考试结束后的提交限制。
