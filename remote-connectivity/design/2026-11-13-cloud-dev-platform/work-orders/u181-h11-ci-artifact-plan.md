# U181 H11–H13 打包产物 CI 方案（2026-11-18）

- 性质：仅供裁定的一页方案；**不改任何代码、工作流或既有文档**，待用户选择后再实施。
- 依据：`cloud-platform/test-reports/u181-h11-h13-feasibility-20261118.md`（PARTIAL）、`u181-h11-h13-runbook-20261118.md`。

## 1. 现状（job / 行号）

| 位置 | 事实 |
| --- | --- |
| `pr.yml:4-10,16-17` | 仅 `pull_request` 触发；`permissions: contents: read`；全文 `secrets.` 出现 0 次 |
| `pr.yml:1018-1182` | `package` job：ubuntu-latest（1022）、90 分钟（1024）、按 `code_paths.outputs.package`（1021）；1145 出 `dist/linux-unpacked`，1146 经 `package-linux-formats.mjs` 产 deb/rpm/AppImage，1152-1159 断言 `dist/orca-ide_<version>_amd64.deb` |
| `pr.yml:448-453` | 全文唯一 `upload-artifact`：typecheck 的 `unit-selection.json`，保留 14 天；**deb 不上传** |
| `release-cut.yml:21-53,68` | 仅 `workflow_dispatch`；限 `stablyai/orca` |
| `release-cut.yml:1227-1274` | `build` 矩阵 linux-x64（1261-1267）；1263 行 `--linux AppImage deb rpm --x64 --publish always -c.publish.releaseType=draft`，deb 只进 **draft release**，无 Actions artifact |
| `release-cut.yml:964/1020/1071/1161/2299` | 其余 `upload-artifact` 只传证据/签名材料（7/14/30 天） |
| `release-cut.yml:1171-1180,2391` | `orcad-template` job 复用 `node-server-tests.yml` 的 `build_template: true`；发布前 `verify-release-required-assets.mjs:16` 校验 deb 资产 |

关键差异：`pr.yml` package job 不建 `out/orcad-template`，也未设 `ORCA_REQUIRE_ORCAD_TEMPLATE`（`config/scripts/packaged-orcad-template.cjs:43-58`），其 deb **不含** `resources/orcad-template`，无法通过 runbook §1.1 第 3 项产物门。

## 2. 三方案

**A. PR package 追加 `upload-artifact`**：`name: u181-deb-<sha>`、`path: dist/orca-ide_*_amd64.deb`、`retention-days: 7`。
- 成本：每次 packaging PR 多 ~30-60s、~150MB；公开仓库 artifact 存储免费；并发组（`pr.yml:12-14`）会取消旧 run 的上传。
- 安全：无 `secrets.*`、checkout `persist-credentials: false`（1030），构建零凭据注入；遥测 key 未设，`WRITE_KEY` 为 null。deb 无令牌，但仍应标为 unsigned/测试用途。
- 缺口：模板缺失未解，A 单独不足以解锁 H11；补 8-target 跨 OS 模板矩阵的成本远大于 A。

**B. 新增 `workflow_dispatch` 专用 job**：先 `uses: node-server-tests.yml`（`build_template: true`）取 `out/orcad-template`，再复用 package 步骤并设 `ORCA_REQUIRE_ORCAD_TEMPLATE=1`，最后上传 deb（7 天）。
- 按需付费、绑定分支精确 SHA、不污染每次 PR；代价是新增约 40-60 行工作流并跟进 release-cut 的同步。

**C. 维持现状，用 release-cut 产物验收**：零改动，可 `workflow_dispatch` `ref=<分支或 SHA>`。
- 偏差：`cut` 追加版本号 commit 并打 tag，产物 = 分支 SHA + bump commit，非 HEAD；执行完整 release 门（数小时）；产生真实 tag/release（`publish-release` 会 un-draft），证据 `commit` 必须记 tag SHA。

## 3. 推荐

推荐 **B**：唯一同时满足 runbook §1.1（含模板）与“验收分支精确内容”的方案，成本按需发生；A 在模板缺口未解决前不足，C 的 bump 与全量发布门使验收既慢又偏离 HEAD。若用户接受“deb 无模板”记为显式偏差，A 为最小改动备选。

## 4. 拿到产物后的执行序列（细节见 runbook）

```bash
mkdir -p dist && cp <deb> dist/orca-ide_<version>_amd64.deb
PKG=$(ls dist/orca-ide_*_amd64.deb); sha256sum "$PKG"   # §1.1 产物门（含 orcad-template grep）
docker build --platform linux/amd64 -f cloud-platform/scripts/relay-e2e-image.Dockerfile \
  --build-arg BASE_IMAGE=node:24-bookworm-slim -t u181-e2e-node24:local .   # §1.2
# 容器启动/自检/装包 §1.2；H11 九项断言 §2；H12c/F2 §3.3、§4；H13 §5
node cloud-platform/scripts/validate-evidence.mjs <evidence-dir>   # §6.4
```

- 自检：U+FFFD 计数 0；未改动任何仓库文件；本方案待用户裁定。
