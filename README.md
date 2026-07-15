# Obsidian Publish markdown

Make an Obsidian Publish site readable by AI agents and plain HTTP clients. Append `.md` to any page URL to get the note's raw markdown source, including frontmatter.

For example, `https://notes.example.com/guide` renders as a normal Publish page, while `https://notes.example.com/guide.md` returns its markdown.

## Features

- `.md` on any page URL returns the note's raw markdown source
- `Accept: text/markdown` content negotiation on normal page URLs
- `/llms.txt`, an auto-maintained site index with per-note descriptions
- `<link rel="alternate">` head tags and RFC 8288 `Link` headers advertising both (opt-out via `HTML_HINTS`)
- An optional pointer comment on markdown responses linking the site index (opt-out via `MD_POINTER`)
- `?resolve=1` rewrites wikilinks into followable markdown links

Together with what Obsidian Publish and Cloudflare already provide (`sitemap.xml`, `robots.txt`), this covers the agent-discovery checks that audits like [isitagentready.com](https://isitagentready.com/?checks=robotsTxt%2Csitemap%2ClinkHeaders%2CmarkdownNegotiation%2CrobotsTxtAiRules%2CcontentSignals) test for.

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
- Emitted links prefer a note's permalink URL when one exists: `/llms.txt` entries, `?resolve=1` rewrites, and advertised markdown alternates all point at `/{permalink}.md` for permalinked notes. Path-form URLs are served either way.
- `/index.md` returns the site's configured index note.
- Markdown responses serve the note source verbatim, including YAML frontmatter, by default. `MD_FRONTMATTER` can strip the frontmatter block or omit selected keys from it.
- The `MD_POINTER` comment is placed after any YAML frontmatter so notes keep `---` as their first line and parsers still recognize the frontmatter.
- Wikilinks to private, unpublished, missing, or ambiguous notes remain literal under `?resolve=1`.
- Missing notes return `404`.
- Every URL without a `.md` suffix passes through untouched.
- Only notes with `publish: true` are reachable. The endpoint serves nothing private.

## Site index for agents

`/llms.txt` provides a plain-text index of every published note. It uses the site's name, groups notes by top-level folder with configurable nested folder headings, and includes frontmatter descriptions when present. The index omits notes hidden from the site's navigation, though their direct `.md` URLs still work. The generated index is memoized for `CACHE_TTL` seconds.

Each successful `.md` response includes a comment near the top pointing agents to the index unless `MD_POINTER` is disabled. The comment follows YAML frontmatter when present so parsers can still recognize frontmatter at the start of the response. Add `?resolve=1` to a markdown URL to turn resolvable wikilinks into absolute markdown links. Embeds and links inside code remain unchanged. Links that cannot be resolved from the published note list also remain unchanged, so private note names are not exposed through guessed URLs.

## Discovery

Agents can find the markdown without knowing the `.md` convention in advance.

- Passthrough HTML pages carry two `<link rel="alternate">` tags in `<head>`: one `type="text/markdown"` pointing at the current page's `.md` URL, and one `type="text/plain"` pointing at `/llms.txt`. The root page links to `/index.md`.
- Those same HTML responses carry a `Link` header advertising both alternates per RFC 8288, so clients can discover them without parsing the body.
- Requests with an `Accept: text/markdown` header receive the note's markdown source for any page URL, without appending `.md`. HTML stays the default for browsers, which ask for `text/html`. Page URLs that resolve to no published note (assets and the like) pass through normally instead of returning `404`.

The markdown served is the note's actual source, not an HTML-to-markdown conversion. Head tags and Link headers are gated on `HTML_HINTS`; content negotiation is always on. Set `HTML_HINTS` to `0` to leave passthrough HTML untouched.

## Variables

- `SITE_UID` identifies the Obsidian Publish site and is required.
- `PUBLISH_HOST` sets the Obsidian Publish origin and defaults to `publish-01.obsidian.md`.
- `CACHE_TTL` sets cache duration in seconds and defaults to `300`.
- `LLMS_HEADING_DEPTH` sets the deepest folder heading level in `/llms.txt`, clamped from `2` through `6` and defaulting to `3`.
- `MD_FRONTMATTER` controls YAML frontmatter in markdown responses. The default `1` serves it verbatim, `0` strips the whole block, and any other value is read as a comma-separated list of top-level keys to omit (for example `aliases,icon,related`) while the rest of the frontmatter is served intact. Malformed frontmatter passes through unmodified.
- `MD_POINTER` controls the index comment in markdown responses. Set it to `0` to return the body verbatim; any other value enables the comment.
- `HTML_HINTS` controls the alternate link tags and `Link` header on passthrough HTML. Set it to `0` to leave HTML untouched; any other value enables the hints.

## Caveat

The `/access/` and `/cache/` endpoints are undocumented internal Obsidian Publish endpoints. They have remained stable for years and are used by the Publish web client itself, but they are not an official API. If they change, the worker fails loudly.

## Live example

[https://nathancheng.fyi/looking.md](https://nathancheng.fyi/looking.md) returns raw markdown. [https://nathancheng.fyi/looking.md?resolve=1](https://nathancheng.fyi/looking.md?resolve=1) resolves its published wikilinks, and [https://nathancheng.fyi/llms.txt](https://nathancheng.fyi/llms.txt) lists the site's published notes. The non-suffixed page at [https://nathancheng.fyi/looking](https://nathancheng.fyi/looking) renders normally.
