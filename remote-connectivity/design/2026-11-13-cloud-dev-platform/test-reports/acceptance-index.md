# 云端开发平台一期 · 验收索引

> 由 `cloud-platform/test/acceptance-index.test.ts`（M99）从 `test-plan.md` 生成并校验：
> 每条 AC 引用的证据文件均已确认存在、非空且为合法 JSON。

| AC | 结论 | 证据文件 | 大小 |
|---|---|---|---|
| AC-01 | PASS | `e2e-platform/E1-direct.json`<br>`m70-acceptance/ac-01-login-latency.json`<br>`m97-workbench-latency/workbench-latency.json` | 603 B<br>159 B<br>685 B |
| AC-02 | PASS | `m70-acceptance/ac-02-login-lockout.json`<br>`m84-shared-login-lockout/shared-lockout.json` | 942 B<br>291 B |
| AC-03 | PASS | `m8-admin-gating/project-visibility.json`<br>`m70-acceptance/ac-03-project-non-disclosure.json` | 228 B<br>611 B |
| AC-04 | PASS | `m70-acceptance/ac-04-project-grant.json`<br>`m95-admin-grant-open/admin-grant-open.json` | 127 B<br>216 B |
| AC-05 | PASS | `e2e-platform/E1-direct.json`<br>`m43-cloud-terminal/m43-1-stream.json`<br>`m85-platform-data-path/platform-not-in-data-path.json` | 603 B<br>261 B<br>240 B |
| AC-06 | PASS | `e2e-platform/E2-relay.json`<br>`m10-relay/whitelisted-sni-forwarded.json`<br>`m90-terminal-over-relay/terminal-over-relay.json` | 536 B<br>124 B<br>239 B |
| AC-07 | PASS | `m91-connect-diagnostics/connect-diagnostics.json`<br>`m101-open-route-diagnostics/open-route-diagnostics.json` | 408 B<br>383 B |
| AC-08 | PASS | `m74-offline-host/host-offline.json`<br>`m70-acceptance/ac-08-heartbeat-offline.json` | 580 B<br>366 B |
| AC-09 | PASS | `m70-acceptance/ac-09-maintenance.json` | 13708 B |
| AC-10 | PASS | `e2e-platform/E5-export-denied.json`<br>`m35-download-policy/m35-1-download-policy.json`<br>`m92-managed-no-export/managed-no-export.json` | 97 B<br>481 B<br>380 B |
| AC-11 | PASS | `e2e-platform/E6-path-boundary.json`<br>`m29-file-contract/m29-3-boundaries.json`<br>`m36-workspace-boundary/m36-1-read-scope.json`<br>`m73-host-audit/m73-host-refusals.json` | 349 B<br>384 B<br>768 B<br>2065 B |
| AC-12 | PASS | `e2e-platform/E7-revocation.json`<br>`m16-control-plane-isolation/policy-hang-still-revokes.json`<br>`m26-revocation-precision/cases.txt`<br>`m88-grant-revocation-live/grant-revocation-live.json`<br>`m96-grant-revocation-scope/grant-revocation-scope.json` | 83 B<br>94 B<br>1083 B<br>129 B<br>114 B |
| AC-13 | PASS | `m31-audit-verify/m31-1-verify.json`<br>`m8-admin-gating/denied-audit.json`<br>`m89-audit-trace-window/audit-trace-window.json` | 353 B<br>580 B<br>426 B |
| AC-14 | PASS | `m71-host-revocation/platform-revocation.json` | 530 B |
| AC-15 | PASS | `e2e-platform/E7c-version-gate.json` | 295 B |
| AC-16 | PASS | `m66-session-persistence/desktop-restart.json`<br>`m98-session-user-isolation/session-user-isolation.json` | 1122 B<br>478 B |
| AC-17 | PASS | `m35-download-policy/m35-1-download-policy.json`<br>`m79-policy-propagation/m79-policy-propagation.json` | 481 B<br>280 B |
| AC-18 | PASS | `m8-admin-gating/denied-audit.json`<br>`m93-web-admin-gating/web-admin-gating.json`<br>`m94-admin-denial-audit/admin-denial-audit.json` | 580 B<br>717 B<br>3368 B |
| AC-19 | PASS | `m78-web-release/web-release.json` | 648 B |
| AC-20 | PASS | `e2e-platform/E8-platform-down.json`<br>`m75-platform-unavailable/m75-outage.json` | 345 B<br>152 B |
| AC-21 | PASS | `m70-acceptance/ac-21-forged-credential.json`<br>`m46-browser-upgrade/m46-2-wrong-device-key.json`<br>`m73-host-audit/m73-host-refusals.json` | 44 B<br>50 B<br>2065 B |
| AC-22 | UNVERIFIED | — | — |
| AC-23 | PASS | `m83-relay-failover/relay-failover.json` | 351 B |
| AC-24 | PASS | `m10-relay/connection-metadata.json`<br>`m85-platform-data-path/platform-not-in-data-path.json`<br>`m86-relay-data-path/relay-ciphertext-only.json`<br>`m46-browser-upgrade/m46-1-subprotocol-upgrade.json` | 1192 B<br>240 B<br>214 B<br>6865 B |
| AC-25 | PASS | `m70-acceptance/ac-25-token-revocation.json`<br>`m11-revocation/device-revoke-closes-session.json` | 212 B<br>280 B |
| AC-26 | PASS | `m80-audit-writer/audit-writer.json`<br>`m31-audit-verify/m31-6-tampered.json`<br>`m32-audit-fail-closed/m32-2-chain-broken.json`<br>`m87-audit-writer-standby/standby-takeover.json`<br>`m100-audit-anchor/audit-anchor.json` | 422 B<br>22 B<br>404 B<br>631 B<br>591 B |
| AC-27 | PASS | `m36-workspace-boundary/m36-1-read-scope.json`<br>`m72-denial-details/m72-path-denial.json`<br>`m73-host-audit/m73-host-refusals.json` | 768 B<br>238 B<br>2065 B |
| AC-28 | PASS | `m34-cloud-rpc-scope/m34-1-readonly.json`<br>`e2e-platform/E4-method-permission.json`<br>`m72-denial-details/m72-path-denial.json`<br>`m73-host-audit/m73-host-refusals.json` | 502 B<br>219 B<br>238 B<br>2065 B |
| AC-29 | PASS | `m77-host-key-pinning/m77-pin-mismatch.json`<br>`m81-host-key-confirmation/m81-host-key-confirmation.json`<br>`m82-web-host-key/m82-web-host-key.json` | 493 B<br>1681 B<br>618 B |
| AC-30 | PASS | `m46-browser-upgrade/m46-2-wrong-device-key.json`<br>`e2e-platform/E7b-device-transplant.json` | 50 B<br>88 B |
| AC-31 | PASS | `m76-signing-key-rotation/ac-31-rotation.json` | 928 B |
| AC-32 | UNVERIFIED | — | — |

合计 32 条：PASS 30、UNVERIFIED 2

未被 test-plan 引用的证据目录（历史模块，未删除）：m102-terminal-echo-latency、m103-file-listing-latency、m104-connection-latency、m105-audit-query-latency、m12-control-plane-resilience、m13-orca-admission、m14-cloud-agent、m15-cloud-session-revocation、m17-review07-gaps、m18-host-enrollment、m19-desktop-connect、m20-cloud-ipc、m21-cloud-ui、m22-project-link、m23-quality-gate、m24-project-workspace、m25-cloud-environment、m27-jwks-staleness、m28-device-pop、m30-project-root、m33-session-limits、m37-git-boundary、m38-worktree-boundary、m39-managed-worktree、m40-ensure-workspace、m41-file-panel、m42-file-panel、m44-agent-boundary、m45-workspace-path-sidecar、m47-web-cloud-transport、m48-web-cloud-session、m49-web-cloud-connect、m50-web-cloud-handoff、m51-cloud-session-recovery、m52-cloud-native-entry、m52-cloud-repo-registration、m53-multi-project、m54-admin-session-page、m55-initial-worktree、m57-project-provisioning、m58-provision-recovery、m59-self-service-projects、m60-create-failure-recovery、m61-session-renewal、m62-web-session-renewal、m63-cloud-device-release、m64-parallel-prepare、m65-project-archive、m67-cloud-agent-launch、m68-milestone-l3、m69-cloud-structured-agent、m9-mtls、web-ui
