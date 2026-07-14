# Obsidian Publish markdown

Append `.md` to any page URL on an Obsidian Publish site to get the note's raw markdown source, including frontmatter.

For example, `https://notes.example.com/guide` renders as a normal Publish page, while `https://notes.example.com/guide.md` returns its markdown.

## Why

Obsidian Publish renders notes client-side. The HTML fetched by a non-browser client is a roughly 4 KB JavaScript shell containing only the title and meta tags. AI agents, feed readers, and plain HTTP fetchers get no content.

Many documentation sites and GitHub support a raw or markdown view convention. This worker adds that convention to an Obsidian Publish site, which makes pages readable to agents through one predictable URL transformation: append `.md`.

## Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nweii/obsidian-publish-md)

The button requires a public GitHub or GitLab repository. The deploy flow reads variables from `wrangler.jsonc` and lets you set `SITE_UID` during deployment or later in the Cloudflare dashboard settings.

You can also deploy manually with Wrangler:

```sh
git clone https://github.com/nweii/obsidian-publish-md.git
cd obsidian-publish-md
wrangler deploy --var SITE_UID:your-32-character-site-uid
```

After deploying, attach the worker to your Publish site's custom domain in the Cloudflare dashboard. Add a route using the pattern `your-domain.com/*`. The domain must be proxied through your own Cloudflare zone (orange-cloud), which is already the common setup for custom domains on Obsidian Publish.

## Finding your site uid

Fetch any page on your Publish site and extract the `uid` value from the `window.siteInfo` object embedded in the HTML:

```sh
curl -s https://your-site.com/ | grep -o '"uid":"[a-f0-9]*"'
```

Read the 32-character hexadecimal value from the output and set it as the worker's `SITE_UID` variable. For example, if the command prints `"uid":"0123456789abcdef0123456789abcdef"`, use `0123456789abcdef0123456789abcdef`.

## Behavior

- Direct file paths work automatically. `/Folder/Note+title.md` reads `Folder/Note title.md` from the published vault.
- Notes served under a `permalink` frontmatter alias are resolved dynamically by reading permalinks from the site's cache endpoint. The permalink map is memoized for `CACHE_TTL` seconds.
- `/index.md` returns the site's configured index note.
- `/llms.txt` lists every published note, grouped by top-level folder with one level of subfolder headings by default.
- Markdown responses include a comment near the top linking to `/llms.txt` and explaining the `?resolve=1` option unless `MD_POINTER` is set to `0`. Notes with YAML frontmatter keep `---` as their first line, with the comment placed after the frontmatter.
- Adding `?resolve=1` rewrites resolvable `[[wikilinks]]` as absolute markdown links. Wikilinks to private, unpublished, missing, or ambiguous notes remain literal.
- Missing notes return `404`.
- Every URL without a `.md` suffix passes through untouched.
- Only notes with `publish: true` are reachable. The endpoint serves nothing private.

## Site index for agents

`/llms.txt` provides a plain-text index of every published note. It uses the site's name, groups notes by top-level folder with configurable nested folder headings, and includes frontmatter descriptions when present. The generated index is memoized for `CACHE_TTL` seconds.

Each successful `.md` response includes a comment near the top pointing agents to the index unless `MD_POINTER` is disabled. The comment follows YAML frontmatter when present so parsers can still recognize frontmatter at the start of the response. Add `?resolve=1` to a markdown URL to turn resolvable wikilinks into absolute markdown links. Embeds and links inside code remain unchanged. Links that cannot be resolved from the published note list also remain unchanged, so private note names are not exposed through guessed URLs.

## Variables

- `SITE_UID` identifies the Obsidian Publish site and is required.
- `PUBLISH_HOST` sets the Obsidian Publish origin and defaults to `publish-01.obsidian.md`.
- `CACHE_TTL` sets cache duration in seconds and defaults to `300`.
- `LLMS_HEADING_DEPTH` sets the deepest folder heading level in `/llms.txt`, clamped from `2` through `6` and defaulting to `3`.
- `MD_POINTER` controls the index comment in markdown responses. Set it to `0` to return the body verbatim; any other value enables the comment.

## Caveat

The `/access/` and `/cache/` endpoints are undocumented internal Obsidian Publish endpoints. They have remained stable for years and are used by the Publish web client itself, but they are not an official API. If they change, the worker fails loudly.

## Live example

[https://nathancheng.fyi/looking.md](https://nathancheng.fyi/looking.md) returns raw markdown. [https://nathancheng.fyi/looking.md?resolve=1](https://nathancheng.fyi/looking.md?resolve=1) resolves its published wikilinks, and [https://nathancheng.fyi/llms.txt](https://nathancheng.fyi/llms.txt) lists the site's published notes. The non-suffixed page at [https://nathancheng.fyi/looking](https://nathancheng.fyi/looking) renders normally.
