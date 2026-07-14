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

function publicUrl(host, filePath) {
  const encoded = filePath.split("/").map((segment) => encodeURIComponent(segment).replace(/%20/g, "+")).join("/");
  return `https://${host}/${encoded}`;
}

async function fetchNote(cfg, filePath) {
  const text = await (await fetch(accessUrl(cfg, filePath))).text();
  return NOT_FOUND_BODY.test(text) ? null : text;
}

async function siteData(cfg) {
  const [siteCache, options] = await Promise.all([
    fetch(`https://${cfg.host}/cache/${cfg.uid}`).then((r) => r.json()),
    fetch(`https://${cfg.host}/options/${cfg.uid}`).then((r) => r.json()),
  ]);
  return { siteCache, options };
}

async function memoized(cfg, requestUrl, name, type, build) {
  const cache = caches.default;
  const key = new Request(new URL(`/__obsidian-publish-md/${name}`, requestUrl));
  const hit = await cache.match(key);
  if (hit) return type === "json" ? hit.json() : hit.text();

  const value = await build();
  const body = type === "json" ? JSON.stringify(value) : value;
  await cache.put(key, new Response(body, {
    headers: { "cache-control": `public, max-age=${cfg.ttl}` },
  }));
  return value;
}

// Builds { permalink → vault file path } from the site's cache endpoint, which
// includes each published note's frontmatter. "index" maps to the site's
// configured index file. Memoized via the Cache API since the site cache JSON
// can be megabytes.
async function permalinkMap(cfg, requestUrl) {
  return memoized(cfg, requestUrl, "permalinks", "json", async () => {
    const map = {};
    const { siteCache, options } = await siteData(cfg);
    for (const [path, meta] of Object.entries(siteCache)) {
      const permalink = meta?.frontmatter?.permalink;
      if (permalink) map[String(permalink).replace(/^\/|\/$/g, "")] = path;
    }
    if (options.indexFile) map["index"] = `${options.indexFile}.md`;
    return map;
  });
}

async function llmsText(cfg, requestUrl) {
  return memoized(cfg, requestUrl, "llms.txt", "text", async () => {
    const { siteCache, options } = await siteData(cfg);
    const groups = new Map();
    for (const [path, meta] of Object.entries(siteCache)) {
      if (!path.endsWith(".md")) continue;
      const slash = path.indexOf("/");
      const group = slash === -1 ? "Root" : path.slice(0, slash);
      const notes = groups.get(group) || [];
      notes.push({ path, description: meta?.frontmatter?.description });
      groups.set(group, notes);
    }

    const host = new URL(requestUrl).host;
    const sections = [...groups].sort(([a], [b]) => {
      if (a === "Root") return -1;
      if (b === "Root") return 1;
      return a.localeCompare(b);
    });
    const lines = [
      `# ${options.siteName}`,
      "",
      "> Every published note on this Obsidian Publish site. Append .md to any page URL for the note's raw markdown source, or add ?resolve=1 to also rewrite [[wikilinks]] into resolvable markdown links.",
    ];
    for (const [group, notes] of sections) {
      lines.push("", `## ${group}`, "");
      notes.sort((a, b) => a.path.localeCompare(b.path));
      for (const note of notes) {
        const title = note.path.slice(note.path.lastIndexOf("/") + 1, -3);
        const description = note.description ? `: ${note.description}` : "";
        lines.push(`- [${title}](${publicUrl(host, note.path)})${description}`);
      }
    }
    return `${lines.join("\n")}\n`;
  });
}

function resolveTarget(target, paths) {
  const normalized = target.replace(/^\//, "");
  const withExtension = normalized.endsWith(".md") ? normalized : `${normalized}.md`;
  if (paths.includes(withExtension)) return withExtension;

  const filename = withExtension.slice(withExtension.lastIndexOf("/") + 1).toLowerCase();
  const matches = paths.filter((path) => path.slice(path.lastIndexOf("/") + 1).toLowerCase() === filename);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    matches.sort((a, b) => a.split("/").length - b.split("/").length);
    if (matches[0].split("/").length < matches[1].split("/").length) return matches[0];
  }
  return null;
}

function rewriteWikilinks(text, paths, host) {
  let fence = null;
  return text.split("\n").map((line) => {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === marker) fence = null;
      else if (!fence) fence = marker;
      return line;
    }
    if (fence) return line;

    const parts = line.split(/(`+[^`]*`+)/g);
    return parts.map((part, index) => {
      if (index % 2 === 1) return part;
      return part.replace(/(?<!!)\[\[([^\]]+)\]\]/g, (wikilink, inner) => {
        const [targetWithSuffix, alias] = inner.split("|", 2);
        const target = targetWithSuffix.split("#", 1)[0];
        const resolved = resolveTarget(target, paths);
        if (!resolved) return wikilink;
        return `[${alias || targetWithSuffix}](${publicUrl(host, resolved)})`;
      });
    }).join("");
  }).join("\n");
}

function addPointer(text, host) {
  const lineEnding = text.includes("\r\n") ? "\r\n" : "\n";
  const pointer = `<!-- Site index for agents: https://${host}/llms.txt · Add ?resolve=1 to this URL to rewrite [[wikilinks]] as markdown links -->${lineEnding}${lineEnding}`;
  const frontmatter = text.match(/^---(?:\r\n|\n)[\s\S]*?(?:\r\n|\n)---[ \t]*(?:(?:\r\n|\n)|$)/);
  if (!frontmatter) return pointer + text;

  const separator = frontmatter[0].endsWith("\n") ? "" : lineEnding;
  return frontmatter[0] + separator + pointer + text.slice(frontmatter[0].length);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "GET" && pathname === "/llms.txt") {
      const cfg = config(env);
      return new Response(await llmsText(cfg, request.url), {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "access-control-allow-origin": "*",
          "cache-control": `public, max-age=${cfg.ttl}`,
        },
      });
    }

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

    if (url.searchParams.get("resolve") === "1") {
      const { siteCache } = await siteData(cfg);
      const paths = Object.keys(siteCache).filter((path) => path.endsWith(".md"));
      text = rewriteWikilinks(text, paths, url.host);
    }

    return new Response(addPointer(text, url.host), {
      status: 200,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "access-control-allow-origin": "*",
        "cache-control": `public, max-age=${cfg.ttl}`,
      },
    });
  },
};
