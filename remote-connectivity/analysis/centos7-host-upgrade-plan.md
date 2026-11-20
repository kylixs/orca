# CentOS 7 主机安全升级计划（192.168.150.220 / `jlc-docker`）

> 目标：把系统从 CentOS 7.3（已 EOL）迁到受支持的系统，同时不丢数据、可回滚、尽量少停机。
> 结论先行：**不建议就地升级**。首选「加一块盘、全新安装、逐项迁移」；受限于单盘时，退而求其次「同盘新建 LV 并行安装、双系统回滚」。

---

## 1. 现状清点（2026-10-22）

### 硬件

| 项         | 值                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| 机型       | 物理机（BIOS 启动，MBR 分区表）                                                                          |
| CPU / 内存 | 4 核 / 15 GB（当前可用 ~11 GB）                                                                          |
| 磁盘       | 单块 `ST1000DM010` 1 TB **机械盘**，无 RAID                                                              |
| LVM        | `cl` VG，`root 50G / swap 7.8G / home 50G / opt 800G`，**VG 剩余 22.76 GB**                              |
| 网络       | 双网卡：`enp2s0 192.168.150.220/24`（默认网关 .1）、`enp4s0 192.168.2.220/24`；Tailscale `100.67.197.59` |
| 远程带外   | **未发现 IPMI/BMC**（`/dev/ipmi0` 不存在，ipmitool 未装）→ 无远程控制台                                  |

### 系统

| 项                  | 值                                                               |
| ------------------- | ---------------------------------------------------------------- |
| OS                  | CentOS Linux 7.3.1611（EOL 2024-06）                             |
| 内核                | 3.10.0-1160.102.1（另装有 elrepo 5.4.258 / 6.4.3）               |
| glibc               | **2.17**                                                         |
| SELinux / firewalld | Disabled / inactive                                              |
| 软件包              | 1108 个；EPEL、SCL、nginx、openresty 等第三方源；40,303 个可装包 |
| 仓库状态            | `mirrorlist.centos.org` 已下线（解析失败），镜像站 aliyun 仍可用 |

### 运行中的业务（迁移范围）

**系统服务（非容器）**

| 服务            | 端口               | 数据/配置                                                  |
| --------------- | ------------------ | ---------------------------------------------------------- |
| PostgreSQL 12   | 5432               | `/var/lib/pgsql`（51 MB）                                  |
| Redis           | 16379              | `/var/lib/redis`（16 MB）                                  |
| nginx（含 TLS） | 80/443/10050/10051 | `/usr/local/nginx`、`/usr/local/openresty`                 |
| APISIX / Kong   | —                  | `/usr/local/apisix`、`/usr/local/kong`（Java 服务 :18007） |
| Zabbix Agent    | 20050              | `/etc/zabbix`                                              |
| Tailscale       | 41641/udp          | 节点名 `jlc-docker`                                        |
| libvirt/dnsmasq | 192.168.122.1:53   | VM `centos7.0`（关机）                                     |
| 自定义          | —                  | `rc.local` 中的 7 条静态路由（经 192.168.2.1）             |
| 其它            | 18100              | 本机 python3 服务                                          |

**容器（数据均在宿主 bind mount）**

| 容器           | 镜像               | 数据路径                                |
| -------------- | ------------------ | --------------------------------------- |
| mysql          | mysql:8.0.27       | `/opt/apps/maxkey/docker-mysql/*`       |
| grafana0       | grafana 9.3.2      | `/opt/apps/prometheus/grafana_data`     |
| prometheus0    | prom/prometheus    | `/opt/apps/prometheus/prometheus_data`  |
| hertzbeat      | tancloud/hertzbeat | `/root/workspace/hertzbeat/*`           |
| node-exporter0 | node-exporter      | —                                       |
| orca-debug     | orca-server:local  | `/opt/orca/work`、`/opt/orca/orca-home` |
| orca-server    | orca-server:v2     | **无挂载**（可写层，需修）              |

### 数据量（`/opt` 共 313 GB / 800 GB）

```
102G /opt/docker        90G /opt/projects      47G /opt/vs2019
 24G /opt/apps          13G /opt/jenkins        12G /opt/tool
9.1G /opt/docker-registry  6.5G /opt/soft      5.3G /opt/data   5.1G /opt/vms
```

Docker 现状：**Docker 17.09 + devicemapper loop-lvm**，261 个镜像；实测容器可写层 `git commit` 比宿主慢 **18–25 倍**（689 ms vs 28 ms），加 bind mount 后恢复到 39 ms。

---

## 2. 风险判断

| 风险                                   | 等级   | 说明                                                                                   |
| -------------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| 无带外控制台                           | **高** | 引导失败时无法远程进救援模式，需人到现场或 KVM                                         |
| 单盘无 RAID、无快照                    | **高** | 磁盘故障 = 全丢；升级过程中的写入无回滚点                                              |
| 系统已运行 1079 天                     | 中     | 累积配置多，重启行为未经验证（`rc.local` 路由、自启服务）                              |
| 大量手工安装组件                       | **高** | `/usr/local/{java,nginx,openresty,apisix,kong,rvm,...}` 非包管理，就地升级会留下不一致 |
| Docker 17.09 devicemapper              | 高     | EL8/9 不再支持；存储与镜像需迁移到 overlay2                                            |
| PostgreSQL 12 / Redis / Zabbix         | 中     | 需按目标系统重新装包并恢复数据                                                         |
| 第三方仓库（EPEL/SCL/nginx/openresty） | 中     | 就地升级时是硬阻断项                                                                   |
| 机械盘性能                             | 中     | 与升级无关，但决定升级后体感；SSD 能一次性解决                                         |

**结论：本机不适合 `yum update` + `leapp` 式就地升级。** 就地升级要求把 7.3 先升到 7.9、清理全部第三方包与手工组件，再跨大版本；任何一步失败都可能让这台无带外的生产机失联。

---

## 3. 方案对比

| 方案                               | 停机              | 回滚                        | 风险   | 适用                 |
| ---------------------------------- | ----------------- | --------------------------- | ------ | -------------------- |
| **A. 新增磁盘 + 全新安装（推荐）** | 一次性 15–30 分钟 | **秒级**（BIOS 选旧盘启动） | 低     | 能加盘/能到现场      |
| **B. 同盘新建 LV 并行安装**        | 同上              | **秒级**（GRUB 选旧系统）   | 中     | 不能加盘，但能到现场 |
| C. 新 VM 承载业务                  | 长（逐项迁移）    | 高（旧机仍在）              | 低     | 有更强的新宿主       |
| D. 就地 centos2alma/leapp          | 1–3 小时+         | **几乎无**                  | **高** | 不推荐               |

### 推荐：A（新盘）→ 退而 B（新 LV）

目标系统：**Rocky Linux 9**（或 AlmaLinux 9），理由：

- 受支持到 2032，EL 生态与现有运维习惯一致（systemd/rpm/firewalld/NetworkManager）；
- **glibc 2.34** → Orca AppImage **可原生运行**，不再需要容器绕 glibc；
- Docker 可用 overlay2（xfs ftype=1），彻底摆脱 devicemapper loop 的写放大；
- 与现有 nginx/openresty/postgres/zabbix 的包生态兼容度最高。

> 若业务更熟 Ubuntu，22.04/24.04 同样可行，但 nginx/openresty/apisix 等需换 PPA 或源码重编。

---

## 4. 推荐方案执行步骤

### 阶段 0：准备与备份（1–2 天，在线完成）

**0.1 全量配置备份到 `/opt/backup/centos7-20261022/`**（`/opt` 余量 487 GB，充足）

```bash
B=/opt/backup/centos7-20261022; mkdir -p $B
tar czf $B/etc.tgz /etc
tar czf $B/root-home.tgz /root /home
tar czf $B/usr-local-etc.tgz /usr/local/etc /usr/local/nginx/conf /usr/local/openresty/nginx/conf
tar czf $B/custom-units.tgz /etc/systemd/system /usr/lib/systemd/system/*.service
rpm -qa > $B/rpm-list.txt; yum repolist > $B/repos.txt
ip addr > $B/ip.txt; ip route > $B/routes.txt; ss -tlnp > $B/ports.txt
docker ps -a --format '{{.Names}}' | xargs -I{} docker inspect {} > $B/docker-inspect.json
```

**0.2 业务数据备份（逐项校验）**

```bash
# PostgreSQL
sudo -u postgres pg_dumpall | gzip > $B/pg-all.sql.gz
# Redis
redis-cli -p 16379 BGSAVE; sleep 2; cp /var/lib/redis/dump.rdb $B/
# MySQL（maxkey）
docker exec mysql sh -c 'exec mysqldump --all-databases -uroot -p"$MYSQL_ROOT_PASSWORD"' | gzip > $B/mysql-all.sql.gz
# Prometheus（快照，避免拷贝过程中写坏）
curl -XPOST http://localhost:9090/api/v1/admin/tsdb/snapshot
# Grafana / 其他 bind mount
tar czf $B/opt-apps.tgz -C /opt apps
tar czf $B/workspace-hertzbeat.tgz -C /root workspace/hertzbeat
# 镜像（只存运行中用到的，避免 102 GB）
for i in mysql:8.0.27 grafana/grafana:9.3.2-ubuntu prom/prometheus:latest \
         prom/node-exporter:latest quay.io/tancloud/hertzbeat orca-server:v2; do
  docker save "$i" | gzip > $B/img-$(echo "$i" | tr '/:' '__').tgz
done
```

**0.3 异地副本**：至少把 `$B` 的 `*.sql.gz`、`*.tgz`（配置与业务数据，不含大镜像）同步到 Tailscale 另一节点，避免单盘故障即全丢。

**0.4 恢复演练**：在目标系统的 VM 中按下面阶段 2 恢复一次 PG/Redis/MySQL/容器，确认备份可用。**未验证的备份等于没有备份。**

**0.5 记录基线**：各服务当前数据量、行数、关键页面截图；作为升级后的验收依据。

---

### 阶段 1：准备新系统介质与安装载体

**A 路线（加盘）**

1. 关机；加一块 ≥256 GB SSD（系统盘），保留原 1 TB 盘不动；
2. BIOS 设 SSD 优先启动；用 Rocky 9 DVD/USB 安装；
3. 分区建议：`/boot 1G`、`/ 100G`、`swap 8G`，其余给 `/data`；**不要格式化原盘**。

**B 路线（不能加盘）**

1. 现有 VG 仅剩 22.76 GB —— 最小安装勉强够（Rocky 9 minimal ≈ 3 GB），但 docker 镜像不宜放这里；
2. 更稳妥：把 `/home`（50 G，实际仅用 ~13 MB）备份后 `lvremove`，重建为 10 G，释放约 40 G → VG 可用 ~62 G，再建 `cl-rocky9 40G`；
3. 用 kickstart（`inst.ks=`）把 Rocky 9 装到新 LV，`clearpart --none`，**只指定新 LV**，绝不碰 `cl-root/cl-opt`；
4. 引导项并行保留：GRUB 默认仍指向 CentOS 7，人工验证新系统可启动后再切换。

> ⚠️ 两条路线都涉及引导/分区操作，**必须有人能在现场或通过 KVM**。若既加不了盘也没有现场条件，方案 A/B 都不成立，只能考虑方案 C/D。

---

### 阶段 2：在新系统上恢复业务（可与旧系统并行，不影响生产）

1. 装 Docker CE（Rocky 9 官方源），配置 `data-root=/opt/docker2`（复用大容量 `/opt` LV），存储驱动 overlay2；
2. 挂载原 `/opt`、`/home`（同一块盘时直接 `mount /dev/cl/opt /opt`）；
3. 恢复容器：`docker load` 镜像 + 按 `$B/docker-inspect.json` 重建（端口、bind mount、restart 策略保持一致）；
4. 装 PostgreSQL 12/16、Redis、nginx/openresty、zabbix-agent、tailscaled；恢复配置与数据；
5. 迁移 `rc.local` 路由到 NetworkManager 的 `route` 配置或 `/etc/NetworkManager/dispatcher.d/`；
6. **先禁用旧系统上的自启**，避免双系统同时启动同一批服务（尤其是数据库容器和 PG）。

**Orca 特别说明**：Rocky 9 上可直接原生运行 AppImage；首选用 bind mount 存放工作区（`/opt/orca/work`），并继续保持 `--no-sandbox` + Xvfb。若继续用容器，也要加 bind mount，禁止使用可写层。

---

### 阶段 3：割接（维护窗口）

1. 停旧系统业务（PG/Redis/nginx/容器），做一次增量备份；
2. 若数据目录共享（同盘 `/opt`），无需搬运；若是新盘，做最终 `rsync`；
3. GRUB/BIOS 切到新系统并重启；
4. 按验收清单逐项验证（见第 6 节）；
5. 观察 24–72 小时。

**回滚**：BIOS/GRUB 选旧系统启动，恢复备份；旧系统与数据保持原样至少 **2 周**再清理。

---

## 5. 如果仍然选择就地升级（不推荐，仅作备案）

1. 先把 7.3 升到 **7.9**（aliyun/vault 源），重启并验证；
2. 清理阻断项：移除 EPEL/SCL/nginx/openresty 等第三方包中不兼容者，卸载 Docker 17.09（先 `docker save` + 备份 `/opt` 数据）；
3. 安装 `leapp`（RHEL 7→8）或 `centos2alma`（CentOS 7→AlmaLinux 8），先跑 **preupgrade 检查报告**，逐条消除 inhibitor；
4. 维护窗口执行升级 → 8 → 9；每步后重启验证；
5. 重装 Docker CE、恢复容器、重建 nginx/openresty/apisix/kong、恢复数据。

**为什么高风险**：无带外控制台；第三方包与 `/usr/local` 手工组件多；PGD 内核与 elrepo 内核并存；Docker 存储驱动必须迁移；任一步失败都可能无法远程恢复。

---

## 6. 验收清单

- [ ] SSH 22 / Orca 6768 可连；Tailscale 节点在线
- [ ] PostgreSQL：`pg_isready`、关键库行数与基线一致
- [ ] MySQL 容器：`mysqladmin ping`、maxkey 数据可读
- [ ] Redis：`redis-cli -p 16379 ping`、key 数量与基线一致
- [ ] nginx 80/443/10050/10051；证书有效期正常
- [ ] Prometheus 9090 数据连续；Grafana 3000 面板可打开且曲线无断档
- [ ] hertzbeat、zabbix-agent、node-exporter 指标上报正常
- [ ] 7 条静态路由（192.168.10/172.16.152/172.16.162/192.168.66/192.168.152-154、172.19.191.10）可达
- [ ] libvirt VM `centos7.0` 可启动；/opt/projects、/opt/vs2019 等数据完好
- [ ] Docker 容器全部 `running`，日志无报错；容器内 `git commit` 耗时为个位数毫秒级
- [ ] Orca 配对链接可生成、PC 与移动端可连接

---

## 7. 时间估算

| 阶段         | 在线/停机                    | 时长     |
| ------------ | ---------------------------- | -------- |
| 0 备份与演练 | 在线                         | 1–2 天   |
| 1 安装新系统 | 在线（B 路线需重启进安装器） | 2–4 小时 |
| 2 恢复业务   | 在线                         | 1 天     |
| 3 割接验证   | **停机 30–60 分钟**          | 1 天观察 |

---

## 8. 同盘双系统方案（已核验硬件可行性）

### 8.1 结论

**可以。** 无需改动分区表，直接从现有 VG 的空闲空间划一个新 LV 给 Rocky 9，复用现有 `/boot`，通过 GRUB 菜单切换。回滚只需在菜单里选回 CentOS。

但必须先明确一点：**双系统不是"共存"**。切到 Rocky 时，CentOS 上的 PostgreSQL / Redis / nginx / MySQL 容器等全部处于停止状态。它是"迁移 + 秒级回滚"的手段，不是让两套系统同时提供服务。

### 8.2 已核验的前提

| 项               | 实测                                         | 结论                                       |
| ---------------- | -------------------------------------------- | ------------------------------------------ |
| CPU              | i5-4460，sse4_2 / ssse3 / popcnt / cx16 齐全 | 满足 Rocky 9 的 x86-64-v2 基线             |
| VG 空闲          | `cl` 22.76 GB                                | 可建 20 GB 新 LV                           |
| `/boot`          | 1014 MB，已用 327 MB，**空闲 688 MB**        | 够放 Rocky 内核 + initramfs（约 60–80 MB） |
| 根分区           | `cl-root` 90% 已用（剩 5.1 GB）              | 不影响；新系统用独立 LV                    |
| `cl-opt`         | 800 GB，剩余 487 GB                          | 可共享给新系统挂载 `/opt`                  |
| xfs              | `ftype=1`                                    | 支持 Docker overlay2                       |
| Rocky 源         | 阿里云 `rockylinux/9` 可访问                 | 可在线安装                                 |
| Rock 容器 rootfs | 阿里云有 86 MB 的 `Container-Base.latest`    | 支持纯远程安装                             |
| 引导工具         | GRUB2 + `grub2-mkconfig` + `os-prober` 已在  | 可手工加/切换菜单项                        |

### 8.3 磁盘布局（不改分区表）

```
sda1  /boot 1G          ← 两套系统共用（安装时严禁重新格式化）
sda2  LVM  cl  VG
 ├─ cl-root   50G       CentOS 7  /   （原样保留）
 ├─ cl-home   50G       /home        （两套系统可共用挂载）
 ├─ cl-opt   800G       /opt         （两套系统可共用挂载）
 ├─ cl-swap  7.8G       swap         （同一时间只有一个系统运行，可共用）
 └─ cl-rocky9 20G  ← 新建，Rocky 9 的 /
```

关键点：**不新增分区、不缩容任何现有 LV**（XFS 不支持缩容），只从 VG 空闲里 `lvcreate`。分区表一个字节都不改。

### 8.4 两条安装路线

**路线 A：有现场 / KVM（标准做法，推荐）**

1. 备份 `/boot/grub2/grub.cfg` 与整个 `/boot`；
2. 用 Rocky 9 ISO 启动，kickstart 关键项：

```
clearpart --none                      # 绝不清盘
ignoredisk --only-use=sda
part /boot --onpart=sda1 --noformat   # 复用现有 /boot，不格式化（最关键一行）
part /     --onpart=cl-rocky9 --fstype=xfs
part swap  --onpart=cl-swap --noformat
bootloader --location=none            # 不写 MBR / 不改 GRUB
selinux --permissive                  # 共享 /opt 没有 SELinux 标签
firewall --disabled                   # 与现网 CentOS 行为保持一致
```

3. 装完不重启，回到 CentOS 手工添加 GRUB 菜单项。

**路线 B：纯远程、无控制台（可行，未实测）**

1. 从阿里云下载 Rocky 9 `Container-Base` rootfs（86 MB）解压到新 LV；
2. `mount --bind` `/proc /sys /dev` 后 `chroot`，用里面的 `dnf` 安装 `kernel kernel-core grub2-tools dracut NetworkManager openssh-server`；
3. 在 chroot 内 `dracut -f` 生成 initramfs（含 lvm 模块）；
4. 在 CentOS 的 `/boot/grub2/grub.cfg` 追加菜单项；
5. 全程**不重启、不碰 MBR**，先把系统装好，选一个窗口用 `grub2-reboot` 做一次性验证。

> 路线 B 的好处是失败的代价小：系统装不好就不切，CentOS 照常运行。坏处是引导项和 initramfs 需要人工校验，比 ISO 安装多一些手工步骤。

### 8.5 GRUB 切换方式

```bash
# 一次性：下次启动进 Rocky，之后再启动自动回到 CentOS（最安全）
grub2-reboot 'Rocky Linux 9 (cl-rocky9)'

# 永久切换默认项
grub2-set-default 'Rocky Linux 9 (cl-rocky9)'
grub2-mkconfig -o /boot/grub2/grub.cfg

# 改回 CentOS
grub2-set-default 'CentOS Linux (3.10.0-1160.102.1.el7.x86_64) 7 (Core)'
```

菜单项写法（追加到 `/etc/grub.d/40_custom` 后再 `grub2-mkconfig`，或直接写 `grub.cfg`）：

```
menuentry 'Rocky Linux 9 (cl-rocky9)' {
    insmod part_msdos
    insmod xfs
    insmod lvm
    set root='hd0,msdos1'
    linux /vmlinuz-<版本>.el9.x86_64 root=/dev/mapper/cl--rocky9 ro \
          rd.lvm.lv=cl/rocky9 rootfstype=xfs
    initrd /initramfs-<版本>.el9.x86_64.img
}
```

> LV 名里的 `-` 在 device-mapper 中要写成 `--`：`cl-rocky9` → `/dev/mapper/cl--rocky9`。

### 8.6 必须注意的坑

| 坑                                            | 后果                                                  | 规避                                                                                              |
| --------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| kickstart 把 `sda1` 重新格式化                | **两套系统的内核全丢，机器无法启动**                  | `part /boot --onpart=sda1 --noformat`，并在安装前备份整个 `/boot`                                 |
| 让安装器写 MBR（`bootloader --location=mbr`） | 回滚路径被改，出问题难恢复                            | 用 `--location=none`，GRUB 配置保持在 CentOS 手里                                                 |
| 两套系统共用 `/boot/grub2/grub.cfg`           | 在 Rocky 里跑 `grub2-mkconfig` 可能抹掉 CentOS 菜单项 | 先备份；Rocky 侧启用 `GRUB_ENABLE_BLSCFG` 时确认 os-prober 能找到 CentOS                          |
| 共享 `/opt` 但两套 Docker 各写各的            | 数据损坏                                              | CentOS 继续用 `/opt/docker`（devicemapper），Rocky 的 data-root 用 **`/opt/docker2`**（overlay2） |
| 切到 Rocky 后重复启动数据库容器               | 与 CentOS 的数据目录冲突                              | 双系统只有一个在运行，切换前确认另一套已关机；不要同时挂同一份数据跑两个实例                      |
| SELinux                                       | 共享目录无标签，服务被拒                              | 首次安装用 permissive                                                                             |
| 无带外控制台                                  | 引导失败需到现场                                      | 先做 `grub2-reboot` 一次性验证；保留 CentOS 为默认项                                              |

### 8.7 双系统方案的定位

- **作为迁移跳板**：非常合适。装好 Rocky 后逐项迁移、随时切回 CentOS 验证旧系统仍可用，风险可控。
- **作为长期共存**：不合适。每次切换都要重启，且另一套业务全停。
- 若目标是"CentOS 业务不停、同时跑 Orca"，双系统帮不上；应选择新机器/VM，或先修好当前容器（加 bind mount）。

## 9. 纯远程新增系统方案（推荐：无需到现场）

### 9.1 目标与约束

- **全新系统**，不迁移任何现有软件/工具；CentOS 7 原样保留作为回滚与旧业务运行环境。
- **全程远程**：安装、配置、切换、回滚都不需要物理接触机器。
- **硬性要求**：新系统首次启动即自动拉起 SSH，否则无法远程验证。
- **任何失败都能自动回到 CentOS**，最坏情况是等待看门狗重启。

### 9.2 先排除"分多次升级内核"这个思路

**升级内核解决不了 Orca 的问题。** Orca 报的是：

```
/orca-ide: /lib64/libm.so.6: version `GLIBC_2.23' not found
/orca-ide: /lib64/libc.so.6: version `GLIBC_2.25' not found
```

这些符号来自 **glibc 用户态库**（`/lib64/libc.so.6`、`libm.so.6`），内核版本不提供、也不影响它们。本机已经装了 elrepo 5.4 / 6.4 内核，切过去后 glibc 仍是 2.17，Orca 依旧起不来。

内核升级只在以下场景有意义：新硬件驱动、文件系统特性、安全修复、cgroup v2（新容器运行时）。它**不是**解决 ABI 兼容的路径；若指的是 7→8→9 的分阶段就地升级，仍然要跨越用户态 glibc，风险与本文件第 5 节相同。

### 9.3 系统选择

| 选项                 | glibc | 远程 base 镜像                                                     | 结论                                                                |
| -------------------- | ----- | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| **Ubuntu 24.04 LTS** | 2.39  | 阿里云 `ubuntu-base-24.04.4-base-amd64.tar.gz`（已验证 200）       | **推荐**：全新系统无迁移包袱，Orca 原生最省心，LTS 支持到 2029/2034 |
| Rocky 9              | 2.34  | 阿里云 `Rocky-9-Container-Base.latest.x86_64.tar.xz`（已验证 200） | 备选：团队偏 RHEL 时选它，支持到 2032                               |

既然不迁移旧软件，前面"Rocky 更省迁移摩擦"的理由不再适用；两者都能满足要求。下文以 **Ubuntu 24.04** 为例，Rocky 9 的差异只在包管理与网络配置。

### 9.4 磁盘与引导布局（不改分区表、不动 `/boot`）

```
sda1  /boot 1G                  CentOS 7 专用，本方案不写入任何文件
sda2  LVM cl
 ├─ cl-root   50G               CentOS 7 /
 ├─ cl-home   50G               （保留）
 ├─ cl-opt   800G               （保留，新系统可按需挂载为 /data）
 ├─ cl-swap  7.8G               共用
 └─ cl-new    20G  ← 新建，ext4，Ubuntu 24.04 根
```

**关键设计：**

- 新系统的 `/boot` 是 `cl-new` LV 内的一个目录，**不占用 sda1**；CentOS 的 `/boot` 和 GRUB 模块完全不碰。
- 新根文件系统用 **ext4**，不用 xfs：本机 GRUB 是 `2.02~beta2`（2016），可能读不了新版 XFS 的特性（bigtime/inobtcount），ext4 没有这个风险。
- 不在新系统里安装/运行 `grub2-install`、`update-grub`，避免模块版本冲突。

### 9.5 远程安装步骤（阶段 1：在线，零风险）

```bash
# 1) 新建 LV（VG 空闲 22.76G，取 20G）
lvcreate -L 20G -n new cl
mkfs.ext4 -L ubuntu2404 /dev/cl/new
mkdir -p /mnt/newroot && mount /dev/cl/new /mnt/newroot

# 2) 下载并解包 Ubuntu base（阿里云可达）
cd /mnt/newroot
curl -O https://mirrors.aliyun.com/ubuntu-cdimage/ubuntu-base/releases/24.04/release/ubuntu-base-24.04.4-base-amd64.tar.gz
tar xzf ubuntu-base-24.04.4-base-amd64.tar.gz && rm -f ubuntu-base-24.04.4-base-amd64.tar.gz

# 3) 准备 chroot 环境
cp /etc/resolv.conf /mnt/newroot/etc/resolv.conf
for d in dev proc sys run; do mount --bind /$d /mnt/newroot/$d; done
chroot /mnt/newroot /bin/bash

# 4) 在 chroot 内安装最小系统（含 SSH 与网络）
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  linux-image-generic initramfs-tools systemd-sysv lvm2 \
  openssh-server systemd-resolved \
  iproute2 iputils-ping curl vim sudo ca-certificates tzdata
ssh-keygen -A
```

> 若选择 Rocky 9，把第 2–4 步换成：解包 `Rocky-9-Container-Base` → `dnf install kernel kernel-core dracut openssh-server NetworkManager`，并在 chroot 外显式生成 initramfs（`dracut -f --add lvm <目标内核版本>`）。

### 9.6 SSH 与网络预配置（首次启动即可远程登录）

这是方案能否远程验证的前提，必须在 chroot 阶段完成并逐项检查。

**网络**：两个网卡都配置，任一通路可用即可登录（同一时间只有一套系统运行，IP 不冲突）。

```bash
cat > /etc/systemd/network/10-enp2s0.network <<'EOF'
[Match]
Name=enp2s0
[Network]
Address=192.168.150.220/24
Gateway=192.168.150.1
DNS=114.114.114.114
EOF

cat > /etc/systemd/network/10-enp4s0.network <<'EOF'
[Match]
Name=enp4s0
[Network]
Address=192.168.2.220/24
EOF

systemctl enable systemd-networkd
systemctl enable systemd-resolved
ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf
```

**SSH**：

```bash
# 复用 CentOS 上已有的 root 公钥（从 chroot 外拷入）
mkdir -p /root/.ssh && chmod 700 /root/.ssh
# 内容来源：CentOS 的 /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys

cat > /etc/ssh/sshd_config.d/99-remote.conf <<'EOF'
PermitRootLogin prohibit-password
PasswordAuthentication no
EOF

# 离线启用（chroot 内没有运行中的 systemd）
systemctl enable ssh.service
systemctl enable ssh.socket
```

**fstab**（root + swap，按 UUID 写，避免 LV 名转义问题）：

```bash
ROOT_UUID=$(blkid -s UUID -o value /dev/cl/new)
SWAP_UUID=$(blkid -s UUID -o value /dev/cl/swap)
cat > /etc/fstab <<EOF
UUID=$ROOT_UUID  /      ext4  defaults        0 1
UUID=$SWAP_UUID  none   swap  sw              0 0
EOF
```

**initramfs**：必须包含 lvm + ext4，否则找不到根分区。

```bash
update-initramfs -c -k all
lsinitramfs /boot/initrd.img-*-generic | grep -E "lvm|ext4|dm-mod"
```

**主机名**：建议设为 `jlc-ubuntu`，避免与 Tailscale 上现有的 `jlc-docker` 重名。

### 9.7 回滚设计（核心）

四层保障，任意一层生效都能回到 CentOS：

| 层  | 机制                                                                                             | 覆盖的失败                            |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------- |
| 0   | **kexec 直启预演**（完全不碰 GRUB）                                                              | 内核 / initramfs / systemd / SSH 问题 |
| 1   | **`next_entry` 一次性启动**：GRUB 读取后立即清空并写回，下次启动自动回到 `saved_entry`（CentOS） | 只需重启即可回退                      |
| 2   | **`panic=30`**：内核 panic 或 initramfs 找不到根时 30 秒后硬件重启                               | systemd 之前的挂死                    |
| 3   | **看门狗服务**：进入 multi-user 后等待远程确认，超时强制重启                                     | 启动了但网络/SSH 不可用               |

已核验：`/boot/grub2/grub.cfg` 第 14–19 行原生实现 `next_entry`；所有 `menuentry` 都**没有**调用 `savedefault`，因此交互式选菜单**不会**改变默认项，只有显式 `grub2-set-default` 才会持久化。

**看门狗（在 chroot 内安装）**：

```bash
cat > /usr/local/sbin/rollback-watchdog <<'EOF'
#!/bin/sh
# 若本次启动未被远程确认，强制重启回到默认启动项（CentOS）。
# 确认按 boot_id 判定，每次启动都重新武装，不会因历史确认而永久失效。
WAIT_MIN=${ROLLBACK_WAIT_MIN:-15}
MARK=/var/lib/rollback-ok
BOOT_ID=$(cat /proc/sys/kernel/random/boot_id)
log() { echo "$(date -Is) $*" >> /var/log/rollback-watchdog.log; }

sleep 60
i=0
while [ "$i" -lt $((WAIT_MIN * 60)) ]; do
  if [ -f "$MARK" ] && [ "$(cat "$MARK" 2>/dev/null)" = "$BOOT_ID" ]; then
    log "confirmed for boot $BOOT_ID; exiting"
    exit 0
  fi
  sleep 10
  i=$((i + 10))
done
log "boot $BOOT_ID not confirmed after ${WAIT_MIN}min; rebooting"
systemctl reboot -f
EOF
chmod 755 /usr/local/sbin/rollback-watchdog

cat > /etc/systemd/system/rollback-watchdog.service <<'EOF'
[Unit]
Description=Reboot to previous OS unless boot is confirmed
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/sbin/rollback-watchdog
Restart=no

[Install]
WantedBy=multi-user.target
EOF
systemctl enable rollback-watchdog.service
```

**确认怎么做：**

确认的本质是**从外部成功连上这台机器** —— 登录动作本身就是最好的验证信号；`confirm-boot` 只是把这个事实记录下来并停表。

```bash
cat > /usr/local/sbin/confirm-boot <<'EOF'
#!/bin/sh
set -e
# 只确认“本次启动”；下一次启动看门狗会重新武装。
ss -tln | grep -q ':22 ' || { echo "sshd 未监听，拒绝确认"; exit 1; }
ip -o -4 route get 192.168.150.1 >/dev/null 2>&1 || { echo "默认路由不可用，拒绝确认"; exit 1; }
cat /proc/sys/kernel/random/boot_id > /var/lib/rollback-ok
chmod 600 /var/lib/rollback-ok
echo "boot confirmed at $(date -Is)" | tee -a /var/log/boot-confirm.log
EOF
chmod 755 /usr/local/sbin/confirm-boot
```

操作流程（在 Mac 上）：

```bash
# 1. 切换并重启
ssh root@192.168.150.220 "grub2-reboot 'Ubuntu 24.04 (cl-new)' && reboot"

# 2. 等待新系统起来（最多 15 分钟，超时会自动回滚）
until ssh -o ConnectTimeout=5 root@192.168.150.220 'echo up'; do sleep 15; done

# 3. 登录后立刻确认
ssh root@192.168.150.220 'cat /etc/os-release | head -2; confirm-boot'
```

**没有确认会怎样**：15 分钟内若无人登录，看门狗执行 `systemctl reboot -f`；由于 `next_entry` 已在 GRUB 阶段被清空，机器会回到 CentOS 默认项。**不会卡在新系统里。**

**重复试验**：标记文件记录的是当次 `boot_id`，因此下次启动会自动重新武装，无需手工清理。

**超时时间可调**：`/etc/default/rollback-watchdog` 里设 `ROLLBACK_WAIT_MIN=30`，或在 unit 里加 `Environment=ROLLBACK_WAIT_MIN=30`。

**GRUB 菜单项（在 CentOS 侧追加）**：

```bash
cp /boot/grub2/grub.cfg /opt/backup/grub.cfg.$(date +%s)
ROOT_UUID=$(blkid -s UUID -o value /dev/cl/new)
KVER=$(ls /mnt/newroot/boot/vmlinuz-* | head -1 | sed 's|.*/vmlinuz-||')

cat >> /etc/grub.d/40_custom <<EOF
menuentry 'Ubuntu 24.04 (cl-new)' {
    insmod part_msdos
    insmod lvm
    insmod ext2
    search --no-floppy --fs-uuid --set=root $ROOT_UUID
    linux /boot/vmlinuz-$KVER root=UUID=$ROOT_UUID ro rootfstype=ext4 panic=30
    initrd /boot/initrd.img-$KVER
}
EOF

# 避免 os-prober 扫描 /opt（800G）并自动生成重复条目
GRUB_DISABLE_OS_PROBER=true grub2-mkconfig -o /tmp/grub.cfg.new
grub2-script-check /tmp/grub.cfg.new
diff /boot/grub2/grub.cfg /tmp/grub.cfg.new   # 确认只多出新条目、旧条目都在
cat /tmp/grub.cfg.new > /boot/grub2/grub.cfg
```

> 生成后务必确认：原有 CentOS 菜单项数量不变，只新增一项 `Ubuntu 24.04 (cl-new)`。

> 若担心 `grub2-mkconfig` 重排，可直接把 menuentry 追加到现有 `grub.cfg` 末尾（同样先备份 + `grub2-script-check`）。两种方式都保留 CentOS 条目。

**切换与回滚命令**：

```bash
grub2-reboot 'Ubuntu 24.04 (cl-new)'   # 仅下次启动进入新系统
shutdown -r now

# 新系统验证通过后，如需长期默认：
grub2-set-default 'Ubuntu 24.04 (cl-new)'

# 任何时候回到 CentOS：
grub2-set-default 'CentOS Linux ... 7 (Core)'
```

**切换前务必确认当前默认项**：

```bash
grub2-editenv list          # 看 saved_entry
awk -F"'" '/^menuentry/{print NR": "$2}' /boot/grub2/grub.cfg
```

### 9.8 裸机切换前的预演

**第 0 层：kexec 直启（不碰 GRUB，风险最低）**

本机 `kexec-tools 2.0.15` 可用。kexec 把新内核直接装入内存并跳转，**完全不经过 GRUB**，因此不存在"改坏引导配置"的风险：

```bash
NEW=/mnt/newroot
KVER=$(ls $NEW/boot/vmlinuz-* | head -1 | sed 's|.*/vmlinuz-||')
ROOT_UUID=$(blkid -s UUID -o value /dev/cl/new)

kexec -l $NEW/boot/vmlinuz-$KVER \
      --initrd=$NEW/boot/initrd.img-$KVER \
      --command-line="root=UUID=$ROOT_UUID ro console=tty0 panic=30"
kexec -e          # 立即跳转到新内核
```

- 成功：机器直接跑起 Ubuntu（未写任何引导配置）；
- 内核 panic / initramfs 找不到根：`panic=30` → 30 秒后重启 → 正常 GRUB → **CentOS**；
- 完全挂死：断电/重启 → 正常 GRUB → **CentOS**。

回到 CentOS 只需 `reboot`。这一步通过后，内核、initramfs、systemd、网络、SSH 就都验证过了，剩下唯一未验证的是"GRUB 能否读取 `cl-new`"。

**第 1 层：QEMU 预演 A —— 验证系统栈（内核 / initramfs / systemd / SSH）**

本机已确认：`/dev/kvm` 存在、`kvm_intel` 已加载、4 核支持 vmx；`qemu-kvm 1.5.3`（EL7 自带，较旧，只用 virtio + 用户态网络即可）。

```bash
# 1) 把新 LV 转成 qcow2（只读源 LV，不修改）
qemu-img convert -f raw -O qcow2 /dev/cl/new /opt/vms/ubuntu2404-os.qcow2

# 2) 用新系统自己的内核与 initramfs 启动，不经过 GRUB
KVER=$(ls /mnt/newroot/boot/vmlinuz-* | head -1 | sed 's|.*/vmlinuz-||')
ROOT_UUID=$(blkid -s UUID -o value /dev/cl/new)   # 转换后 UUID 保持不变
/usr/libexec/qemu-kvm -m 4096 -smp 2 -enable-kvm \
  -drive file=/opt/vms/ubuntu2404-os.qcow2,if=virtio,format=qcow2 \
  -kernel /mnt/newroot/boot/vmlinuz-$KVER \
  -initrd /mnt/newroot/boot/initrd.img-$KVER \
  -append "root=UUID=$ROOT_UUID ro console=tty0 console=ttyS0,115200 panic=30" \
  -nographic \
  -netdev user,id=n0,hostfwd=tcp::2222-:22 -device virtio-net-pci,netdev=n0
```

验证点（全部通过才算过）：

- 内核消息与 systemd 输出出现在串口；
- 启动到 multi-user，无 failed unit；
- `ssh -p 2222 root@127.0.0.1` 能登录；
- `findmnt /`、`dfs -n`、`systemctl --failed`、`ss -tln` 正常；
- 重启 VM 一次，仍能进系统（验证 fstab/initramfs 自洽）。

> QEMU 1.5.3 不支持较新的 `-machine` 选项，保持默认 `pc`；磁盘用 `if=virtio`，网络用 `-netdev user`。

**第 2 层：QEMU 预演 B —— 验证 GRUB 真实启动路径**

这一步专门验证"**GRUB 2.02~beta2 能否读取 ext4 + LVM 上的新系统**"，也就是裸机切换时唯一未被 A 覆盖的环节。做法是造一个与生产布局同构的**独立测试镜像**（VG 名改成 `vgtest`，绝不触碰生产 VG），在 QEMU 里走完整 GRUB 流程。

> 本机 **`nbd` 内核模块不可用**（`modprobe nbd` 失败），因此改用 `losetup -P` 直接挂在 raw 镜像上。否则流程相同。

```bash
set -e
IMG=/opt/vms/grubtest.img

# 1) 建 raw 镜像并接入（先建文件，再挂 loop）
qemu-img create -f raw "$IMG" 26G
DISK=$(losetup -P -f --show "$IMG")
[ -n "$DISK" ] || { echo "拒绝执行：无法创建 loop 设备"; exit 1; }
[ "$DISK" != "/dev/sda" ] || { echo "拒绝执行：设备名不对"; exit 1; }   # 安全护栏
partprobe "$DISK"

# 2) 分区：1G /boot(ext4) + 其余 LVM
parted -s "$DISK" mklabel msdos \
  mkpart primary ext4 1MiB 1GiB set 1 boot on \
  mkpart primary 1GiB 100% set 2 lvm on
partprobe "$DISK"

# 3) 关键：用宿主的 mkfs.ext4 (e2fsprogs 1.42.9) 建文件系统。
#    它默认不开 metadata_csum / 64bit / orphan_file，GRUB 2.02 可读；
#    Ubuntu 24.04 的 e2fsprogs 默认特性 GRUB 2.02 读不了。
mkfs.ext4 -L tboot "${DISK}p1"
pvcreate "${DISK}p2"
vgcreate vgtest "${DISK}p2"
lvcreate -L 20G -n root vgtest
mkfs.ext4 -L troot /dev/vgtest/root

# 4) 安装 GRUB 到测试镜像的 MBR（只写 loop 设备，不写 /dev/sda）
mkdir -p /mnt/tboot /mnt/troot
mount "${DISK}p1" /mnt/tboot
mount /dev/vgtest/root /mnt/troot
grub2-install --boot-directory=/mnt/tboot "$DISK"

# 5) 拷贝新系统根（保留 xattr/acl）
#    先卸载 chroot 的绑定挂载，避免把 /dev /proc 复制进镜像
for d in dev proc sys run; do umount /mnt/newroot/$d 2>/dev/null || true; done
rsync -aHAX --numeric-ids /mnt/newroot/ /mnt/troot/

# 6) 拷贝内核与 initrd 到测试 /boot，并写测试用 GRUB 菜单
KVER=$(basename "$(ls /mnt/troot/boot/vmlinuz-* | head -1)" | sed 's|^vmlinuz-||')
mkdir -p /mnt/tboot/boot
cp -f "/mnt/troot/boot/vmlinuz-$KVER"   /mnt/tboot/boot/
cp -f "/mnt/troot/boot/initrd.img-$KVER" /mnt/tboot/boot/

cat > /mnt/tboot/grub2/grub.cfg <<EOF
set timeout=5
set default=0
menuentry 'Ubuntu 24.04 (vgtest)' {
    insmod part_msdos
    insmod lvm
    insmod ext2
    set root='hd0,msdos1'
    linux /boot/vmlinuz-$KVER root=/dev/vgtest/root ro console=tty0 console=ttyS0,115200 panic=30
    initrd /boot/initrd.img-$KVER
}
EOF

# 7) 卸载、停止 VG、断开 loop（避免宿主与 VM 同时持有 vgtest）
umount /mnt/troot /mnt/tboot
vgchange -an vgtest
losetup -d "$DISK"

# 8) 用完整 GRUB 流程启动（写入镜像文件，可反复重来）
/usr/libexec/qemu-kvm -m 2048 -smp 2 -enable-kvm \
  -drive file="$IMG",if=virtio,format=raw \
  -nographic -netdev user,id=n0,hostfwd=tcp::2223-:22 -device virtio-net-pci,netdev=n0
```

验证点：

- GRUB 读取分区表 → `insmod lvm`/`ext2` → 找到 `/boot/vmlinuz-test`（**这是裸机切换唯一的新增风险点**）；
- 内核接管后 initramfs 激活 `vgtest`，挂载根；
- `ssh -p 2223 root@127.0.0.1` 登录，`findmnt /` 显示 `/dev/mapper/vgtest-root`；
- 失败可直接删掉 `$IMG` 重来，**生产机与生产 VG 完全未被触碰**。

> 生产菜单项与测试项的差异只有三处：`root=UUID=...`（生产）vs `root=/dev/vgtest/root`（测试）、内核文件名、VG 名。GRUB 模块与语法完全一致，因此 B 通过即可认为 GRUB 路径可靠。

**为什么 ext4 特性兼容必须显式检查**

GRUB 2.02~beta2（本机 2016 年版）不支持 ext4 的 `metadata_csum_seed`、`orphan_file` 等新特性。用 Ubuntu 24.04 的 `mkfs.ext4` 格式化会默认开启其中一部分，导致 GRUB 报 `unknown filesystem`。本方案的规避方式：

1. 用**宿主 CentOS 的 `mkfs.ext4`（1.42.9）**创建 `cl-new`，它只开 `sparse_super,filetype,resize_inode,dir_index,ext_attr`；
2. 创建后校验：`dumpe2fs -h /dev/cl/new | grep features`，确认**没有** `metadata_csum`、`64bit`、`orphan_file`；
3. 若已误建，先 `tune2fs -O ^metadata_csum,^64bit,^orphan_file` 再用 `e2fsck -f` 重整。

### 9.9 切换后如何连接（本机）

新系统沿用与 CentOS 相同的地址，端口为**标准 22**（不是容器里的 2222）：

```bash
ssh root@192.168.150.220
```

- 认证方式：**仅公钥**（`PasswordAuthentication no`），已把本机 Mac 的 `~/.ssh/id_ed25519.pub` 写入 `cl-new` 的 `/root/.ssh/authorized_keys`；
- 双网卡同时可用：`192.168.150.220`（默认网关 150.1）与 `192.168.2.220`，任一通路都能登录；
- 登录后**第一时间**执行确认，否则 15 分钟后看门狗会把机器重启回 CentOS：

```bash
ssh root@192.168.150.220 'confirm-boot'
```

- 回滚：`ssh root@192.168.150.220 'reboot'`（默认启动项仍是 CentOS），或直接等待看门狗超时。

### 9.10 裸机切换与验收

1. `grub2-reboot` → 重启；
2. 3–5 分钟内从 Mac 执行 `ssh root@192.168.150.220`；
3. 登录后立刻 `touch /var/lib/rollback-ok` 停用看门狗；
4. 验收：
   - SSH 双网卡可达；Tailscale（如安装）在线
   - `uname -r` / `cat /etc/os-release` 确认新系统
   - Orca AppImage 原生启动，`serve --port 6768` 成功并生成配对链接
   - Docker（如安装）使用 overlay2，容器可运行
   - 重启一次，确认仍能进入新系统（此时可 `grub2-set-default`）
5. 若任一步失败：不做任何操作，等待 15 分钟看门狗自动重启回到 CentOS；或主动 `reboot`。

### 9.10 残余风险（必须知情）

| 风险                                    | 概率 | 缓解                                                                |
| --------------------------------------- | ---- | ------------------------------------------------------------------- |
| 内核/initramfs 早期挂起（systemd 之前） | 低   | VM 预演必须先通过；使用发行版官方内核与 initramfs                   |
| GRUB 读不了 `cl-new`                    | 低   | ext4 + LVM 是 GRUB 2.02 成熟路径；默认项仍是 CentOS，失败后重启即回 |
| `grub.cfg` 语法错误导致两套系统都起不来 | 低   | 追加前备份、`grub2-script-check` 校验、保留原文件                   |
| 新系统能启动但网络/SSH 不通             | 中   | 双网卡 + 看门狗；静态 IP 与旧系统一致，切换时旧系统已关闭           |
| 机器彻底无响应，需要断电重启            | 低   | 本机无 IPMI；若条件允许，建议后续补带外管理或可远程控制的电源       |

### 9.11 分阶段检查点（每阶段全部通过才进入下一阶段）

#### Phase 0 — 备份与基线（在线，零风险）

- [ ] `/boot` 全量备份存在且 `tar -tzf` 可读
- [ ] `grub.cfg`、`grubenv`、`/etc/default/grub` 已备份
- [ ] `rpm -qa`、`repolist`、`ip addr/route`、`ss -tlnp`、`docker ps -a` 快照已保存
- [ ] 现有业务的基线数据（PG/Redis/MySQL 行数与关键值）已记录
- [ ] 至少一份备份已复制到另一台机器（Tailscale 内）
- [ ] **中止条件**：任一备份无法读取 → 停止，先解决备份

#### Phase 1 — 创建新系统（在线，不影响 CentOS）

- [ ] `lvs` 显示 `cl-new` 20G，且 `cl-root/cl-home/cl-opt` 大小未变
- [ ] `dumpe2fs -h /dev/cl/new` 的 features 中**没有** `metadata_csum` / `64bit` / `orphan_file`
- [ ] rootfs 解包完成，`chroot /mnt/newroot /bin/bash -c 'uname -m'` 正常
- [ ] `apt-get install` 退出码为 0，无 `dpkg` 错误
- [ ] `/mnt/newroot/boot/vmlinuz-*` 与 `initrd.img-*` 存在
- [ ] `lsinitramfs` 中可见 `lvm`、`ext4`、`dm-mod`
- [ ] **中止条件**：apt 失败、内核未安装、initramfs 缺 lvm → 保留 `cl-new` 排查，不进入 Phase 2

#### Phase 2 — 预配网络 / SSH / 回滚（在线）

- [ ] `sshd_config.d/99-remote.conf` 存在，`sshd -t` 通过（chroot 内执行）
- [ ] `authorized_keys` 内容与 CentOS 上的公钥逐字节一致（`sha256sum` 对比）
- [ ] `/etc/systemd/network/*.network` 含两个网卡与网关
- [ ] `/etc/fstab` 的 root/swap UUID 与 `blkid` 一致
- [ ] 主机名 `jlc-ubuntu`，`/etc/hostname` 已写
- [ ] 看门狗 unit 已 enable；`/var/lib/rollback-ok` **不存在**
- [ ] `confirm-boot` 可执行且脚本语法检查通过（`sh -n`）
- [ ] **中止条件**：SSH 配置或 fstab 校验失败 → 修复后重做 QEMU-A

#### Phase 3 — QEMU 预演 A（系统栈）

- [ ] 内核与 systemd 输出可见，无 panic
- [ ] `systemctl --failed` 为空
- [ ] `ssh -p 2222 root@127.0.0.1` 登录成功
- [ ] `findmnt /` 指向预期设备，`df -h` 正常
- [ ] 看门狗在运行；执行 `confirm-boot` 后停用
- [ ] 重启 VM 一次仍能进入（fstab/initramfs 自洽）
- [ ] **中止条件**：SSH 不通 → 不进入 Phase 4；回到 Phase 2 修复

#### Phase 4 — QEMU 预演 B（GRUB 真实路径）

- [ ] 测试镜像中 GRUB 能加载 `lvm`、`ext2` 模块并找到内核（串口可见）
- [ ] 内核挂载 `/dev/mapper/vgtest-root` 成功
- [ ] `ssh -p 2223 root@127.0.0.1` 登录成功
- [ ] 生产 VG `cl` 未被激活到测试镜像，`/dev/sda` 未被写入
- [ ] **中止条件**：GRUB 报 unknown filesystem 或找不到内核 → 排查 ext4 特性/模块，不进入 Phase 5

#### Phase 5 — 追加 GRUB 菜单项（低风险，可回滚）

- [ ] `grub.cfg` 已备份（带时间戳）
- [ ] `grub2-script-check` 通过
- [ ] `diff` 显示旧条目**数量不变**，仅新增一项
- [ ] `grub2-editenv list` 中 `saved_entry` 仍指向 CentOS，**未**设置 `next_entry`
- [ ] **中止条件**：diff 出现旧条目被删改 → 立即还原备份

#### Phase 6 — 一次性切换与确认

- [ ] `grub2-reboot 'Ubuntu 24.04 (cl-new)'` 后 `grub2-editenv list` 显示 `next_entry`
- [ ] 重启后 5 分钟内 `ssh root@192.168.150.220` 登录成功
- [ ] `cat /etc/os-release` 显示 Ubuntu 24.04
- [ ] `ls /dev/mapper/cl-new`、`findmnt /` 正确
- [ ] 执行 `confirm-boot`，看门狗停用
- [ ] **未确认时**：等待 15 分钟，机器自动重启回 CentOS（验证回滚生效）

#### Phase 7 — 稳定运行与持久化（可选）

- [ ] 新系统连续运行 ≥ 72 小时无异常
- [ ] 再重启一次，手动在 GRUB 菜单选择 Ubuntu 也能进入
- [ ] 只有此时才考虑 `grub2-set-default`；否则保持 CentOS 为默认、按需 `grub2-reboot`
- [ ] 保留 CentOS 与全部备份 ≥ 2 周后再清理

## 10. 实施记录（2026-10-22 ～ 2026-10-23）

### 10.1 结果

**已切换并固化：主机现在默认启动 Ubuntu 24.04.4 LTS。**

| 项         | 实际结果                                                                          |
| ---------- | --------------------------------------------------------------------------------- |
| 新系统     | Ubuntu 24.04.4 LTS，内核 6.8.0-147-generic，glibc **2.39**                        |
| 根文件系统 | `/dev/mapper/cl-new`，ext4，20G（已用 2.5G）                                      |
| 分区表     | **未改动**：`sda1 /boot`、`sda2 LVM cl` 原样保留                                  |
| CentOS 7   | `cl-root` 50G 原样保留，可随时回滚                                                |
| 网络       | `enp2s0 192.168.150.220/24`（网关 .1）、`enp4s0 192.168.2.220/24`，MAC 锁定网卡名 |
| SSH        | 22 端口，仅公钥（含本机 Mac 的 `id_ed25519`），开机即用                           |
| swap       | `cl-swap` 7.7G 已启用                                                             |
| 启动项     | `saved_entry=Ubuntu 24.04 (cl-new)`，已重启验证自动进入                           |
| 失败单元   | 无                                                                                |
| **Orca**   | **原生运行成功**：`Orca server ready`，生成 `scope=runtime` 配对链接，无需容器    |

### 10.2 当前未迁移（有意为之）

新系统是**干净系统**，以下旧业务**未运行**：

- 容器：mysql、grafana、prometheus、hertzbeat、node-exporter、orca-server、orca-debug
- 系统服务：PostgreSQL 12、Redis 4.0、nginx、OpenResty、APISIX、Kong、Zabbix Agent、Tailscale、libvirt
- `rc.local` 中的 7 条静态路由

**`/opt` 已挂载**：`cl-opt`（800G，已用 320G）已写入 fstab 并验证可自动挂载，旧数据（docker/projects/apps/vs2019/backup）全部完好可访问。

### 10.3 执行中遇到并修正的问题（重要经验）

| 问题                         | 现象                                            | 修正                                                                     |
| ---------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------ |
| ext4 `64bit` 特性            | 宿主 `mkfs.ext4` 默认开启，GRUB 2.02 可能读不了 | `mkfs.ext4 -O ^64bit`，并 `dumpe2fs` 校验                                |
| OpenSSH 9.6 拒绝 RSA         | `Permission denied (publickey)`                 | 追加 ed25519 公钥；旧 RSA 密钥需显式 `PubkeyAcceptedAlgorithms +ssh-rsa` |
| 阿里云镜像慢                 | 147 kB/s，索引下载 4 分钟                       | 切**华为云** `repo.huaweicloud.com`，9 MB/s                              |
| 看门狗确认后永久失效         | 标记文件存在就一直跳过                          | 改为记录 **boot_id**，每次启动重新武装                                   |
| SSH 会话结束后台 reboot 被杀 | `(sleep 3; systemctl reboot) &` 未生效          | 用 `nohup ... </dev/null &`，或直接前台 `systemctl reboot`               |
| 测试镜像 fstab 指向生产 UUID | root 以 ro 挂载，logind 反复失败                | 测试镜像单独写 vgtest UUID；生产 fstab 本身正确（QEMU-A 已验证）         |
| Ubuntu base 缺 GUI 库        | `libnss3/libgtk-3/libcups... not found`         | 安装 Electron 运行库（见 10.4）                                          |

### 10.4 运行时依赖（Orca 原生）

```bash
apt-get install -y --no-install-recommends \
  libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libcairo2 \
  libgtk-3-0t64 libpango-1.0-0 libgbm1 libasound2t64 libxss1 libsecret-1-0 \
  libnotify4 libxdamage1 libxcomposite1 libxrandr2 libxkbcommon0 libdrm2 \
  libxfixes3 libxtst6 libxi6 xvfb fonts-liberation
```

启动方式（无头）：

```bash
xvfb-run -a -s "-screen 0 1280x1024x24" \
  /path/to/orca-linux.AppImage --appimage-extract-and-run --no-sandbox \
  serve --port 6768 --pairing-address 192.168.150.220
```

### 10.5 现在的回滚方式（默认项已改）

默认启动项已是 Ubuntu，回滚需要显式改回：

```bash
# 在 Ubuntu 上挂载 CentOS /boot 并改默认项
apt-get install -y grub-common
mount /dev/sda1 /mnt/centosboot
grub-editenv /mnt/centosboot/grub2/grubenv set saved_entry='CentOS Linux (3.10.0-1160.102.1.el7.x86_64) 7 (Core)'
umount /mnt/centosboot
reboot          # 之后自动进入 CentOS
```

一次性进入 CentOS（不改默认）：

```bash
grub-editenv /mnt/centosboot/grub2/grubenv set next_entry='CentOS Linux (3.10.0-1160.102.1.el7.x86_64) 7 (Core)'
```

> CentOS 的 `/boot` 是 `sda1`（xfs），Ubuntu 内核可直接挂载；`grub-editenv` 来自 `grub-common`。
> 修改前先备份 `grubenv`（实施时已自动备份到 `/mnt/centosboot/grub2/grubenv.bak-*`）。

### 10.6 后续建议

1. ~~挂载 /opt~~ **已完成**：
   `UUID=21026a71-f47a-4710-91d1-574f747b3213  /opt  xfs  defaults,nofail,noatime  0 2`
   （`nofail` 保证盘异常时系统仍可启动；已验证 `umount /opt && mount -a` 正常）
2. **Docker**：安装 Docker CE（overlay2），`data-root` 指向 `/opt/docker2`，避免复用旧 devicemapper 目录。
3. **业务迁移**：按第 4 节阶段 2 逐项恢复（PG/Redis/MySQL/nginx/Prometheus...）。
4. **Orca 常驻**：写成 systemd 服务，配合 `Restart=always`，替代原容器方案。

### 10.7 Orca 常驻服务（取代原容器方案）

新系统上 Orca 以 **systemd 服务**运行，不再依赖 Docker：

```ini
# /etc/systemd/system/orca-server.service
[Unit]
Description=Orca runtime server (headless)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=HOME=/root
Environment=PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WorkingDirectory=/opt/orca
ExecStart=/usr/bin/xvfb-run -a -s "-screen 0 1280x1024x24" /opt/orca/orca-linux.AppImage --appimage-extract-and-run --no-sandbox serve --port 6768 --pairing-address 192.168.150.220
Restart=always
RestartSec=5
KillMode=control-group
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

要点：

- `Type=simple` + `KillMode=control-group`：停止服务时连同 xvfb-run 与 orca-ide 一起清理，避免残留；
- 与容器方案不同，这里的 `xvfb-run` **不是 PID 1**，不存在"AppImage 不启动"的问题；
- 状态目录为 `/root/.config/orca`（在 20G 根 LV 上，约 6.5MB），工作区在 `/opt`（800G）。

常用命令：

```bash
systemctl status orca-server
journalctl -u orca-server -f
systemctl restart orca-server
journalctl -u orca-server | grep "Pairing URL" | tail -1
```

**本机 Orca 已导入**为新环境 `150.220-ubuntu`（`ws://192.168.150.220:6768`，`scope: runtime`），旧的 `150.220-docker` 已移除。CLI 验证：`orca status --environment 150.220-ubuntu` → `connected`，RPC 约 150–200ms。

**性能对比（2000 文件 `git add + commit`）**：

| 环境                              | 耗时       |
| --------------------------------- | ---------- |
| 旧容器可写层（devicemapper loop） | **689 ms** |
| 新系统原生（`/opt` xfs on HDD）   | **57 ms**  |

### 10.8 Orca 原生运行所需补充依赖

Ubuntu base 不包含 GUI 库，安装以下包即可（已在主机上执行）：

```bash
apt-get install -y --no-install-recommends \
  libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libcairo2 \
  libgtk-3-0t64 libpango-1.0-0 libgbm1 libasound2t64 libxss1 libsecret-1-0 \
  libnotify4 libxdamage1 libxcomposite1 libxrandr2 libxkbcommon0 libdrm2 \
  libxfixes3 libxtst6 libxi6 xvfb fonts-liberation
```

### 10.9 国内镜像与工具链

主机不直连境外源，统一走国内镜像：

| 用途                                           | 源                                                       | 配置位置                |
| ---------------------------------------------- | -------------------------------------------------------- | ----------------------- |
| Ubuntu apt                                     | `repo.huaweicloud.com`（实测 9 MB/s，阿里云仅 147 kB/s） | `/etc/apt/sources.list` |
| Node 二进制                                    | `mirrors.tuna.tsinghua.edu.cn/nodejs-release`            | 手动下载                |
| npm registry                                   | `registry.npmmirror.com`                                 | `/root/.npmrc`          |
| npm 二进制（electron/sass/sharp/chromedriver） | `npmmirror.com/mirrors/*`                                | `/root/.npmrc`          |
| PyPI                                           | `pypi.tuna.tsinghua.edu.cn`                              | `/etc/pip.conf`         |
| GitHub 加速（按需）                            | `https://ghfast.top/<原始URL>`                           | `GH_PROXY` 环境变量     |

统一环境变量写在 `/etc/profile.d/cn-mirrors.sh`：

```bash
export npm_config_registry=https://registry.npmmirror.com
export PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node/
export GH_PROXY=https://ghfast.top/
```

> **npm 10 注意**：`npm config set disturl/electron_mirror` 会因键名校验报错，需直接写 `~/.npmrc`。

### 10.10 Claude Code 安装

```bash
# Node 22（清华镜像）
curl -fL -o /tmp/node.tar.xz \
  https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/v22.11.0/node-v22.11.0-linux-x64.tar.xz
mkdir -p /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
for b in node npm npx corepack; do ln -sf /opt/node/bin/$b /usr/local/bin/$b; done

# Claude Code（npmmirror）
npm config set registry https://registry.npmmirror.com
npm install -g @anthropic-ai/claude-code
ln -sf /opt/node/bin/claude /usr/local/bin/claude
```

已安装：**Node v22.11.0 / npm 10.9.0 / Claude Code 2.1.309**。

注意两点：

- Ubuntu base 缺 `xz-utils`，解压 `.tar.xz` 前需先装；
- 新版 Claude Code 的 npm 包提供**原生二进制** `bin/claude.exe`（293 MB，Linux 可直接执行），不是 JS 入口；`npm` 只在 `/opt/node/bin` 建了链接，需手动补 `/usr/local/bin/claude`。

### 10.11 普通运维用户 `jlc`

创建 `uid=1000` 的普通用户，**不加入 `sudo` / `docker` 组**，权限全部通过 `/etc/sudoers.d/jlc` 显式授予。

#### 权限分层

| 类别         | 内容                                                                                                                                                                                                                                                               | 密码 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| 只读诊断     | `systemctl status/is-active/is-enabled/list-*/show/cat`、`journalctl`、`ss`、`df`、`free`、`uptime`、`who`、`w`、`dmesg`、`ip addr/route/link show`、`last`、`lastlog`                                                                                             | 免密 |
| 服务生命周期 | 白名单服务的 `start/stop/restart/reload`：ssh、cron、docker、systemd-networkd、systemd-resolved、orca-server、rollback-watchdog、nginx、postgresql、redis-server、zabbix-agent、tailscaled；以及 `enable/disable`（ssh/cron/docker/orca-server）与 `daemon-reload` | 免密 |
| Docker 容器  | `ps/images/logs/inspect/stats/system df/start/stop/restart`                                                                                                                                                                                                        | 免密 |
| 显式拒绝     | `journalctl --vacuum*`、`systemctl mask/edit/reboot`、`docker run/exec/build/compose/prune`、`bash`、`apt`                                                                                                                                                         | —    |

#### 关键设计说明

- **服务名写死，不用通配**：`systemctl start *` 等于把 root 交出去（可启动任意 unit）。
- **Docker 只放生命周期**：`docker run -v /:/host` 可挂载宿主根文件系统，等同于 root；因此刻意排除 `run/exec/build/compose/prune`。
- **无参命令要单独列**：sudo 的 `cmd *` 要求至少一个参数，`ip addr show` 这类无参形式需额外写 `cmd`。
- **路径必须是真实路径**：Ubuntu 上 `ip` 位于 `/usr/sbin/ip`，写成 `/usr/bin/ip` 会静默不匹配。
- **否定规则放在允许规则之后**：sudo 以最后一条匹配的规则为准。

#### 风险提示

- `systemctl stop ssh` 会切断远程登录（需从控制台恢复）；规则按需求放行，操作前确认。
- 白名单服务若其 `ExecStart` 指向 jlc 可写的脚本，重启该服务即等于执行任意代码 —— 新增服务到白名单前需确认这一点。
- `jlc` 使用与 root 相同的 SSH 公钥登录；如需独立密钥，替换 `/home/jlc/.ssh/authorized_keys`。

校验命令：

```bash
visudo -c -f /etc/sudoers.d/jlc
sudo -l -U jlc
su - jlc -c 'sudo -n systemctl is-active ssh'
```

### 10.12 Tailscale（已停用）

> **2026-10-28 更新：`tailscaled` 已 `disable --now`，不再随开机启动。** 节点状态与恢复方式见本节末尾。

新系统曾安装 Tailscale **1.104.2**，并**复用旧 CentOS 的节点身份**（`/var/lib/tailscale/tailscaled.state`），因此 tailnet 地址保持不变：

| 项         | 值                                         |
| ---------- | ------------------------------------------ |
| tailnet IP | **100.67.197.59**（与旧系统相同）          |
| MagicDNS   | `jlc-docker.tailf600dc.ts.net`             |
| IPv6       | `fd7a:115c:a1e0::782d:c53c`                |
| 当前状态   | **disabled / inactive**（2026-10-28 停用） |

**Orca 的监听与配对地址是两个概念**：

- `serve --port 6768` 监听 `0.0.0.0`，**所有网卡同时可用**（LAN + tailnet）；
- `--pairing-address` 只决定配对链接里发布的地址，不影响实际监听。

因此停用 Tailscale 后，把 `--pairing-address` 改回 LAN 地址即可继续使用：

```
serve --port 6768 --pairing-address 192.168.150.220
```

**恢复 Tailscale**：

```bash
systemctl enable --now tailscaled
tailscale status
```

⚠️ **复用节点身份的副作用**：新旧系统共用同一节点密钥。**不要让两套系统同时运行 tailscaled** —— 否则会争抢同一节点，表现为断连抖动。旧 CentOS 若需启动，先 `systemctl disable --now tailscaled`。

⚠️ **主机密钥变化**：tailnet 地址在客户端 `known_hosts` 中记录的是旧 CentOS 的主机密钥，切换后首次连接会报 `REMOTE HOST IDENTIFICATION HAS CHANGED`。执行一次：

```bash
ssh-keygen -R 100.67.197.59
```

**安装注意**：`pkgs.tailscale.com` 在国内下载很慢（apt 会长时间卡住），可从本机下载 deb 后 `scp` + `dpkg -i`；依赖 `iptables` 需一并安装。

## 11. 需要确认的决策点

1. **能否加一块 SSD？** 能 → 走 A 路线，风险最低，同时根治卡顿；不能 → B 路线。
2. **能否到现场 / 有无 KVM、IPMI？** 若都没有，任何引导级改动都存在失联风险，需要先补带外管理。
3. **维护窗口**：允许的最长停机时间？
4. **备份落地位置**：是否有 NAS / 另一台机器（Tailscale 内的 `100.124.255.3` 等）可存放异地副本？
