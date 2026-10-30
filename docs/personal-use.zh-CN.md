# 个人投递助手：第一版

已实现：正职 / 博士 / CIFRE 筛选、NVIDIA / Meta / Google 实习白名单、中文去重与过滤、中英文简历版本库，以及本地岗位筛选网页。邮件连接尚未实现。

## 启动

在项目目录运行：

```powershell
.\scripts\start-personal.ps1
```

启动器优先使用系统 Node.js，也支持工作区 `.tools/node-*-win-x64` 下的便携版本。默认数据目录是项目旁边的 `ApplyPilot-Private`，首次启动使用 `cn-eu-careers` 配置，保留已有资料。页面地址为 `http://localhost:4321/prepare`，原看板也有“岗位筛选 / 简历选择”入口。此页面的筛选和简历选择完全离线，不调用模型。

## 登记简历

请使用自己确认后的 PDF。每个 ID 对应一个不可覆盖的版本；更新文件请登记新 ID。中文和英文分别登记。系统复制 PDF 到私人数据目录并保存 SHA-256，不修改源文件。

以下命令需在可使用 Node.js 的终端运行（本机便携 Node 位于工作区 `.tools`）：

```powershell
$env:APPLY_PILOT_HOME = 'D:\antiGravity_workspace\ApplyPilot-Private'
node .\bin\apply-pilot.mjs resume add 'D:\你的简历\机器人英文.pdf' --id robotics-en-v1 --language en --tracks robotics --types full_time,phd,cifre --keywords ROS,SLAM
node .\bin\apply-pilot.mjs resume list
```

`--tracks` 可使用逗号分隔的 `robotics,autonomous_driving,mathematics,machine_learning,product,software`；`--types` 可选择 `full_time,phd,cifre,internship`。只登记该简历真正适合的方向和岗位类型。关键词只用于多个合格版本之间排序；同分时需要人工选择。

没有登记的简历不会被凭空生成；法语简历不在版本库范围内。法语 JD 可以使用英文附件，但必须根据招聘要求选择材料语言。

## 从文件筛选

在私人数据目录下创建一个岗位 JSON，例如：

```json
{
  "company": "Example Lab",
  "role": "PhD position in robotics",
  "jobType": "phd",
  "track": "robotics",
  "resumeLanguage": "en",
  "description": "Research topic: SLAM and navigation"
}
```

```powershell
node .\bin\apply-pilot.mjs screen "$env:APPLY_PILOT_HOME\job.json" --out "$env:APPLY_PILOT_HOME\output\job-report-v1.json"
```

结果包含筛选原因、推荐文件、文件校验值和材料缺口。已有报告不会被覆盖。`ready` 表示材料版本匹配，不代表满足所有签证、学历、在读资格要求，也不表示已经提交。

## 筛选规则与 AI 评估

- 私人 `profile.json` 中的 `jobPolicy` 控制岗位类型和实习公司白名单。
- 白名单按公司名称及明确别名匹配；正文提到 Google 不会让其他公司的实习通过。
- 普通实习被排除；白名单实习保留，但实习资格仍需确认；未知岗位类型保留为待确认。
- 扫描初筛 `triage` 与 AI 评估结果使用同一规则。高分不会覆盖实习限制。
- 网页 / `screen` 仅做规则检查和材料选择。现有 `eval` 流程仍负责基于完整 JD 的能力匹配评分。
- `profile.candidate.facts` 和语言能力留空，待用户提供确认后的中英文简历再整理，避免沿用冲突的旧经历。首次配置没有预设招聘来源，需要配置后再扫描。
- 当前不读取邮箱，不发送邮件，不自动提交申请。

## 验证

`npm test` 同时运行原有回归测试和新增个人投递场景。重点覆盖中文名称、职位 URL 参数、公司白名单、PhD 实习、跨方向误选、法语材料要求、文件被修改和同分版本。
