The source of my blog, [ykiko.me](https://ykiko.me): articles on C++, compilers and developer tools, in Chinese and English.

The site is built with [Hugo](https://gohugo.io/) and the [PaperMod](https://github.com/adityatelange/hugo-PaperMod) theme (both pinned in [deploy.yaml](.github/workflows/deploy.yaml)), with comments by [giscus](https://giscus.app/). GitHub Actions builds it and publishes it to GitHub Pages; the domain is on Cloudflare.

I publish an article on Zhihu first, and most of the discussion and later edits happen there. A daily CI job fetches my Zhihu articles into `website/content/zh-cn/articles`, so edits made on Zhihu reach the blog on their own. English versions are translated by hand with Gemini (see `translate_articles.ts` below); nothing is translated automatically.

`code/` holds the example code the articles link to.

## Scripts

The tools in `scripts/` are TypeScript run directly by Node.js (≥ 26); run `npm ci` first.

- `node scripts/zhihu_cli.ts sync [article_id ...]`: fetch my Zhihu articles (all of them, or the ones given) into `website/content/zh-cn/articles`, then format the repository with pixi. CI runs it daily.
- `node scripts/zhihu_cli.ts login`: log in to Zhihu by scanning a QR code; the cookie is cached in `.cookie/zhihu.yaml`, and `--gh-secret ZHIHU_COOKIE` also updates the secret CI uses.
- `node scripts/zhihu_cli.ts publish <file> [--column <column id>]`, `update-article [file] [--article-id <id>] [--column <column id> | --no-column]`, `preview`: publish or update an article (an update keeps the column in its front matter by default), or push a draft and print its preview link.
- `node scripts/md_format.ts [--fix] [file ...]`: check (`--fix`: fix) Chinese typesetting against [FORMAT_SPEC.md](FORMAT_SPEC.md).
- `node scripts/translate_articles.ts`: translate changed Chinese articles into English by hand, through the Antigravity CLI (`agy`). CI never runs it.
- `npm run check`, `npm test`: type check and tests.
