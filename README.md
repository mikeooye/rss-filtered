# RSS Filter Worker

本地项目对应 Cloudflare 上名为 `rss-filter` 的 Worker。Worker 聚合多个 RSS/Atom 订阅源，使用 Cloudflare KV 绑定 `CONFIG` 保存订阅源设置和全局排除关键词。

管理页面支持校验并添加订阅地址、启停订阅源、为每个源单独开启同类合并，以及用标签管理全局排除词。合并目前按中国时区的同一天和标题中的共同产品/主题词做匹配；每组显示最新文章标题，并在正文保留组内文章链接。

部署后，管理页面在 Worker 根地址 `/`（需要现有管理员密码），聚合 RSS 地址为 `/rss`（订阅器可直接访问）。

## 部署到 Cloudflare

安装 Node.js 和 npm 后，先用 `npx wrangler login` 登录 Cloudflare，再运行：

```sh
npm run deploy
```

脚本会使用 Wrangler 4.145.0 将当前目录的 `worker.js` 部署到线上 `rss-filter`。部署后打开 Cloudflare 上的 Worker 网址检查效果。线上 Worker 使用配置中的 `CONFIG` KV，因此读取线上关键词规则；抓取的也是外部 RSS 源。

`npm run deploy` 会更新线上服务。运行前请确认本地代码已经准备好发布。

`ADMIN_PASSWORD` 和 `API_KEY` 的线上密钥值不需要复制到本地文件。Cloudflare 会在部署时保留已有加密密钥；`wrangler.jsonc` 中只声明必需的密钥名称。
