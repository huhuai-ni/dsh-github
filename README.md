# dsh-github

DSH 插件：**直接管理你的 GitHub 账号。**

## 工具

| 工具 | 作用 |
|---|---|
| `github_set_token` | 保存 PAT（只写本机 `~/.dsh/github-manager/config.json`） |
| `github_whoami` | 当前账号、仓库数、粉丝 |
| `github_repos` | 列仓库（含私人，按更新时间） |
| `github_repo` | 单仓详情 |
| `github_search_repos` | 搜仓库 |
| `github_issues` | 列 issue（可按指派给我过滤） |
| `github_issue_create` | 新建 issue |
| `github_pulls` | 列 PR |
| `github_notifications` | 未读通知 |
| `github_actions` | Actions 运行记录 |
| `github_star` | 点星 / 取消 |

## 需要的权限

**经典 PAT**：勾 `repo`、`notifications`、`read:user`。
细粒度 PAT 也能用，但**通知接口不支持细粒度令牌**。

## 安装

```bash
dsh plugin --profile desktop add dsh-github
```

配好 token 后：

```
「看看我最近有哪些仓库」
「给我的仓库建个 issue：补 LICENSE」
```

## 一个坑（本项目踩过）

某些机器装了做 TLS 拦截的安全软件，Node 内置 CA 不认它的根证书，`fetch` 直接失败（`UNABLE_TO_VERIFY_LEAF_SIGNATURE`）。
所以这里用 `node:https` + `tls.getCACertificates('system')` 走系统证书库。

## 安全

- token 只存本机，不上传、不写日志
- 除「建 issue」「点星」外都是只读
- 建议用细粒度或短有效期令牌

## 许可

MIT