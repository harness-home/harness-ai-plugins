# harness-ai-plugins

**English** | [中文](#中文)

The community plugin catalog for [Harness AI](https://harnessai.io): a scanner that reads the public npm registry, and the snapshot it produces.

- **[`catalog.json`](catalog.json) is the output.** It is generated, not edited. `harness-ai-server` fetches it on a schedule, validates it and upserts it into the catalog the website and the desktop client read.
- **What gets listed:** every package published to npm under the `dsh-plugin` keyword. Listing is automatic and is *not* an endorsement — see below.
- **What `installable` means:** the package manifest declares `dsh.bundle.patch`, the registry pinned a tarball integrity hash, and installing it runs no lifecycle scripts. Packages that miss any of those are still listed, because people search for them, but the desktop client refuses to install them.
- **`riskFlags` are observations, not verdicts:** install scripts, native builds, missing provenance, missing license, low adoption, a very new package. They are shown before an install so the decision is the user's.

Nothing here is a security review. The listing carries the registry's own metadata and nothing more, and the desktop client re-reads the integrity hash from npm before it installs anything — a catalog entry cannot talk it into installing different bytes.

```bash
pnpm install
pnpm scan        # rescan the registry and rewrite catalog.json (~1 minute)
pnpm validate    # check the committed snapshot against the contract
pnpm verify      # typecheck + unit tests + validate
```

The scan lives here rather than in the server because one pass fetches a manifest per candidate — around 1500 requests. A Cloudflare Worker is capped far below that per invocation, so the same code running there silently reached about 3% of the registry and reported success. A GitHub runner has no such ceiling.

## 中文

[Harness AI](https://harnessai.io) 的社区插件目录：一个扫描公共 npm registry 的脚本，以及它产出的快照。

- **[`catalog.json`](catalog.json) 是产物**，由脚本生成，不要手改。`harness-ai-server` 定时拉取、校验后写进目录库，官网与桌面客户端读的就是它。
- **收录口径**：npm 上带 `dsh-plugin` 关键字的包全部自动收录。**收录不等于背书**。
- **`installable` 的含义很窄**：包清单声明了 `dsh.bundle.patch`、registry 给出了 tarball 完整性哈希、且安装期不跑任何生命周期脚本。三者缺一就只能浏览不能安装（桌面客户端会拒绝）。
- **`riskFlags` 是观察不是判决**：安装脚本、原生编译、缺少来源证明、缺少许可证、下载量低、刚发布不久。它们在安装前展示，决定权在用户。

**这里没有任何安全审核。** 条目只携带 registry 自己的元数据；桌面客户端在真正安装前会回 npm 复核完整性哈希——一条被篡改的目录记录骗不到「装进另一份字节」。

扫描之所以放在这个仓库而不是服务端：一次全量要按候选逐个拉包清单，约 1500 次请求，而单次 Cloudflare Worker 调用的子请求上限远低于此——同一份代码跑在那里只够到约 3% 的 registry，还会报成功。GitHub runner 没有这个限制。

工作区约定与文档：见 [harness-ai 根仓库](https://cnb.cool/kafudev/harness-home/harness-ai)。
