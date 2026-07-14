// Cloudflare Worker that adds a raw-markdown convention to an Obsidian Publish
// site: appending .md to any page URL returns the note's markdown source.
// All other requests pass through to Obsidian Publish untouched.

const NOT_FOUND_BODY = /^## Not Found\n/;

function config(env) {
  const uid = env.SITE_UID;
  if (!uid) throw new Error("SITE_UID is not set. See README: find it in window.siteInfo in your site's HTML source.");
  return {
    uid,
    host: env.PUBLISH_HOST || "publish-01.obsidian.md",
    ttl: parseInt(env.CACHE_TTL || "300", 10),
  };
}

function accessUrl({ host, uid }, filePath) {
  const encoded = filePath.split("/").map(encodeURIComponent).join("/");
  return `https://${host}/access/${uid}/${encoded}`;
}

async function fetchNote(cfg, filePath) {
  const text = await (await fetch(accessUrl(cfg, filePath))).text();
  return NOT_FOUND_BODY.test(text) ? null : text;
}

// Builds { permalink → vault file path } from the site's cache endpoint, which
// includes each published note's frontmatter. "index" maps to the site's
// configured index file. Memoized via the Cache API since the site cache JSON
// can be megabytes.
async function permalinkMap(cfg, requestUrl) {
  const cache = caches.default;
  const key = new Request(new URL(`/__obsidian-publish-md/permalinks`, requestUrl));
  const hit = await cache.match(key);
  if (hit) return hit.json();

  const map = {};
  const [siteCache, options] = await Promise.all([
    fetch(`https://${cfg.host}/cache/${cfg.uid}`).then((r) => r.json()),
    fetch(`https://${cfg.host}/options/${cfg.uid}`).then((r) => r.json()),
  ]);
  for (const [path, meta] of Object.entries(siteCache)) {
    const permalink = meta?.frontmatter?.permalink;
    if (permalink) map[String(permalink).replace(/^\/|\/$/g, "")] = path;
  }
  if (options.indexFile) map["index"] = `${options.indexFile}.md`;

  await cache.put(key, new Response(JSON.stringify(map), {
    headers: { "cache-control": `public, max-age=${cfg.ttl}` },
  }));
  return map;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    // Publish's own raw endpoint also ends in .md; never intercept it.
    if (!pathname.endsWith(".md") || pathname.startsWith("/access/")) {
      return fetch(request);
    }

    const cfg = config(env);

    // "/Folder/Some+note.md" → "Folder/Some note"
    const page = decodeURIComponent(pathname.slice(1, -3)).replace(/\+/g, " ");

    let text = await fetchNote(cfg, `${page}.md`);
    if (text === null) {
      const map = await permalinkMap(cfg, request.url);
      if (map[page]) text = await fetchNote(cfg, map[page]);
    }
    if (text === null) {
      return new Response(`No published note at /${page}\n`, { status: 404 });
    }

    return new Response(text, {
      status: 200,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": `public, max-age=${cfg.ttl}`,
      },
    });
  },
};
