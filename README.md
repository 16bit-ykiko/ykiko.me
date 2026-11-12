这是我的个人博客，博客地址是：https://ykiko.me

使用 Github Pages 进行部署，域名是在 Godaddy 上购买的，使用 Cloudflare 进行 CDN 加速。

使用的静态博客生成器是 [Hugo](https://gohugo.io/)，主题是 [blowfish](https://blowfish.page/)，使用的评论系统是 [giscus](https://giscus.app/zh-CN)，页面底部的看板娘来自于 [live2d](https://github.com/stevenjoezhang/live2d-widget)。

> 评论和看板娘的部署类似，都只要把相关的加载代码加入到页面的 footer 中即可。

一般来说，每当我写了一篇新文章之后，会把它发布到知乎上。之后的交流讨论和修改文章大多数时候也是在知乎上进行的。为了保证相关的修改能自动同步到博客，我写了一个爬虫脚本，每天自动爬取知乎上我的文章，进行同步。

> 目前 zhihu 加强了对爬虫的限制，正常的 API 没有 cookies 是没法请求成功的。这里我是使用了以前的 API 来绕过，不确定能坚持到什么时候。
>
> 果然，不到一个月，这个 API 就被封了，考虑其它解决办法吧。

博客有双语支持，但是考虑到我可能频繁修改文章，所以手动翻译不是一个好的选择。我一直在寻找一个比较靠谱的 AI 翻译来进行文章的批量翻译，但暂时还没有找到。如果找到了之后，可能也会把这些文章发布到 Reddit 上。

## 脚本

`scripts/` 下的工具用 TypeScript 编写，由 Node.js（≥ 26）直接运行，先 `npm ci` 安装依赖：

- `node scripts/zhihu_cli.ts sync`：把知乎上的全部文章同步到 `website/content/zh-cn/articles`，再用 pixi 格式化仓库，CI 每天跑一次
- `node scripts/zhihu_cli.ts login`：扫码登录知乎，cookie 缓存在 `.cookie/zhihu.yaml`；加上 `--gh-secret ZHIHU_COOKIE` 会同时更新 CI 用的 secret
- `node scripts/zhihu_cli.ts publish <文件> [--column <专栏 id>]`、`update-article [文件] [--article-id <id>] [--column <专栏 id> | --no-column]`、`preview`：发布、更新文章（更新时默认沿用 front matter 里的专栏），或者只推送草稿并给出预览链接
- `node scripts/md_format.ts [--fix] [文件 ...]`：按 [FORMAT_SPEC.md](FORMAT_SPEC.md) 检查（`--fix` 修复）中文排版
- `node scripts/translate_articles.ts`：手动把改动过的中文文章翻译成英文，调用 Antigravity CLI（`agy`），CI 里不会运行
- `npm run check`、`npm test`：类型检查和测试
