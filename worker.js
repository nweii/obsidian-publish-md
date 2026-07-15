// Cloudflare Worker that makes an Obsidian Publish site readable by AI agents
// and plain HTTP clients. Appending .md to any page URL returns the note's
// markdown source; agents can also request markdown by content negotiation
// (Accept: text/markdown) or discover it through head link tags and Link
// headers added to passthrough HTML. All other requests pass through untouched.

const NOT_FOUND_BODY = /^## Not Found\n/;

function config(env) {
  const uid = env.SITE_UID;
  if (!uid) throw new Error("SITE_UID is not set. See README: find it in window.siteInfo in your site's HTML source.");
  return {
    uid,
    host: env.PUBLISH_HOST || "publish-01.obsidian.md",
    ttl: parseInt(env.CACHE_TTL || "300", 10),
    llmsHeadingDepth: Math.min(6, Math.max(2, parseInt(env.LLMS_HEADING_DEPTH || "3", 10) || 3)),
    mdPointer: env.MD_POINTER !== "0",
    mdFrontmatter: env.MD_FRONTMATTER || "1",
    htmlHints: env.HTML_HINTS !== "0",
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

// Builds { byPermalink: { permalink → vault file path }, byPath: the inverse }
// from the site's cache endpoint, which includes each published note's
// frontmatter. byPermalink resolves permalink URLs inbound and gains an "index"
// entry for the site's configured index file; byPath canonicalizes emitted
// links to a note's permalink form. Memoized via the Cache API since the site
// cache JSON can be megabytes.
async function permalinkMaps(cfg, requestUrl) {
  return memoized(cfg, requestUrl, "permalink-maps", "json", async () => {
    const byPermalink = {};
    const byPath = {};
    const { siteCache, options } = await siteData(cfg);
    for (const [path, meta] of Object.entries(siteCache)) {
      const permalink = normalizePermalink(meta?.frontmatter?.permalink);
      if (permalink) {
        byPermalink[permalink] = path;
        byPath[path] = permalink;
      }
    }
    if (options.indexFile) byPermalink["index"] = `${options.indexFile}.md`;
    return { byPermalink, byPath };
  });
}

function normalizePermalink(permalink) {
  return permalink ? String(permalink).replace(/^\/|\/$/g, "") : null;
}

// The URL a generated link should point at: the note's permalink form when it
// has one, its vault path otherwise.
function canonicalUrl(host, path, byPath) {
  return publicUrl(host, byPath[path] ? `${byPath[path]}.md` : path);
}

async function llmsText(cfg, requestUrl) {
  return memoized(cfg, requestUrl, "llms.txt", "text", async () => {
    const { siteCache, options } = await siteData(cfg);
    const hiddenItems = Array.isArray(options.navigationHiddenItems) ? options.navigationHiddenItems : [];
    const groups = new Map();
    for (const [path, meta] of Object.entries(siteCache)) {
      if (!path.endsWith(".md")) continue;
      if (hiddenItems.some((item) => path === item || path.startsWith(`${item}/`))) continue;
      const slash = path.indexOf("/");
      const group = slash === -1 ? "Root" : path.slice(0, slash);
      const notes = groups.get(group) || [];
      notes.push({
        path,
        description: meta?.frontmatter?.description,
        permalink: normalizePermalink(meta?.frontmatter?.permalink),
      });
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
    const addHeading = (heading) => {
      if (lines.at(-1) !== "") lines.push("");
      lines.push(heading, "");
    };
    const addNote = (note) => {
      const title = note.path.slice(note.path.lastIndexOf("/") + 1, -3);
      const description = note.description ? `: ${note.description}` : "";
      const target = note.permalink ? `${note.permalink}.md` : note.path;
      lines.push(`- [${title}](${publicUrl(host, target)})${description}`);
    };
    const addFolder = (notes, segmentIndex) => {
      if (segmentIndex + 2 >= cfg.llmsHeadingDepth) {
        notes.forEach(addNote);
        return;
      }

      const direct = [];
      const children = new Map();
      for (const note of notes) {
        const segments = note.path.split("/");
        if (segments.length === segmentIndex + 2) {
          direct.push(note);
          continue;
        }
        const child = segments[segmentIndex + 1];
        const childNotes = children.get(child) || [];
        childNotes.push(note);
        children.set(child, childNotes);
      }
      direct.forEach(addNote);
      for (const [child, childNotes] of [...children].sort(([a], [b]) => a.localeCompare(b))) {
        addHeading(`${"#".repeat(segmentIndex + 3)} ${child}`);
        addFolder(childNotes, segmentIndex + 1);
      }
    };
    for (const [group, notes] of sections) {
      addHeading(`## ${group}`);
      notes.sort((a, b) => a.path.localeCompare(b.path));
      if (group === "Root") notes.forEach(addNote);
      else addFolder(notes, 0);
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

function rewriteWikilinks(text, paths, host, byPath) {
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
        return `[${alias || targetWithSuffix}](${canonicalUrl(host, resolved, byPath)})`;
      });
    }).join("");
  }).join("\n");
}

// Leading YAML frontmatter block, including its trailing line break.
const FRONTMATTER = /^---(?:\r\n|\n)[\s\S]*?(?:\r\n|\n)---[ \t]*(?:(?:\r\n|\n)|$)/;

function stripFrontmatter(text) {
  return text.replace(FRONTMATTER, "").replace(/^(?:\r\n|\n)+/, "");
}

// Serves frontmatter per MD_FRONTMATTER: "1" keeps it verbatim, "0" strips the
// whole block, and anything else is a comma-separated list of top-level keys to
// omit. Key removal is line-based: a match is an unindented "key:" line, removed
// along with its indented or list-item continuation lines. Text without a
// well-formed frontmatter block passes through unmodified.
function filterFrontmatter(text, setting) {
  if (setting === "1") return text;
  if (setting === "0") return stripFrontmatter(text);

  const match = text.match(FRONTMATTER);
  const keys = setting.split(",").map((key) => key.trim()).filter(Boolean);
  if (!match || keys.length === 0) return text;

  const lines = match[0].split(/\r\n|\n/);
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^---[ \t]*$/.test(lines[i])) { close = i; break; }
  }
  if (close === -1) return text;

  const kept = [];
  let omitting = false;
  for (const line of lines.slice(1, close)) {
    // An unindented non-list line starts a new top-level entry; indented lines,
    // list items, and blank lines belong to whichever entry preceded them.
    if (/^\S/.test(line) && !/^-(\s|$)/.test(line)) {
      omitting = keys.some((key) => line.startsWith(`${key}:`));
    }
    if (!omitting) kept.push(line);
  }
  if (kept.every((line) => line.trim() === "")) return stripFrontmatter(text);

  const lineEnding = match[0].includes("\r\n") ? "\r\n" : "\n";
  const trailing = /(?:\r\n|\n)$/.test(match[0]) ? lineEnding : "";
  return ["---", ...kept, "---"].join(lineEnding) + trailing + text.slice(match[0].length);
}

function addPointer(text, host) {
  const lineEnding = text.includes("\r\n") ? "\r\n" : "\n";
  const pointer = `<!-- Site index for agents: https://${host}/llms.txt · Add ?resolve=1 to this URL to rewrite [[wikilinks]] as markdown links -->${lineEnding}${lineEnding}`;
  const frontmatter = text.match(FRONTMATTER);
  if (!frontmatter) return pointer + text;

  const separator = frontmatter[0].endsWith("\n") ? "" : lineEnding;
  return frontmatter[0] + separator + pointer + text.slice(frontmatter[0].length);
}

// "/Folder/Some+note.md" or "/Folder/Some+note" → "Folder/Some note".
// The root path maps to "index".
function pageName(pathname) {
  const withoutSuffix = pathname.endsWith(".md") ? pathname.slice(0, -3) : pathname;
  return decodeURIComponent(withoutSuffix.slice(1) || "index").replace(/\+/g, " ");
}

// Serves a note's markdown for a page URL, shared by the .md route and Accept
// content negotiation. Returns null when no published note matches, letting the
// caller decide between a 404 and falling through to passthrough.
async function markdownResponse(cfg, url, requestUrl) {
  const page = pageName(url.pathname);

  let text = await fetchNote(cfg, `${page}.md`);
  if (text === null) {
    const { byPermalink } = await permalinkMaps(cfg, requestUrl);
    if (byPermalink[page]) text = await fetchNote(cfg, byPermalink[page]);
  }
  if (text === null) return null;

  text = filterFrontmatter(text, cfg.mdFrontmatter);

  if (url.searchParams.get("resolve") === "1") {
    const [{ siteCache }, { byPath }] = await Promise.all([siteData(cfg), permalinkMaps(cfg, requestUrl)]);
    const paths = Object.keys(siteCache).filter((path) => path.endsWith(".md"));
    text = rewriteWikilinks(text, paths, url.host, byPath);
  }

  return new Response(cfg.mdPointer ? addPointer(text, url.host) : text, {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": `public, max-age=${cfg.ttl}`,
      // Negotiated by the Accept header, so shared caches must key on it.
      "vary": "Accept",
    },
  });
}

// The markdown alternate for an HTML page URL, or null for paths that have no
// page markdown (the root maps to /index.md; .md and /llms.txt are skipped).
// Pages backed by a permalinked note advertise the permalink form; the lookup
// is a memoized map read, and any failure falls back to the path-derived
// alternate so passthrough HTML never breaks over a hint.
async function markdownAlternate(cfg, requestUrl, pathname) {
  if (pathname === "/") return "/index.md";
  if (pathname.endsWith(".md") || pathname === "/llms.txt") return null;
  try {
    const { byPath } = await permalinkMaps(cfg, requestUrl);
    const permalink = byPath[`${pageName(pathname)}.md`];
    if (permalink) return `/${permalink}.md`;
  } catch {}
  return `${pathname}.md`;
}

// Appends alternate-representation link tags into <head> of passthrough HTML.
class HeadHints {
  constructor(mdHref) {
    this.mdHref = mdHref;
  }
  element(head) {
    if (this.mdHref) {
      head.append(`<link rel="alternate" type="text/markdown" href="${this.mdHref}">`, { html: true });
    }
    head.append(`<link rel="alternate" type="text/plain" href="/llms.txt" title="llms.txt">`, { html: true });
  }
}

// Passes a request through to Obsidian Publish, then advertises the markdown and
// llms.txt alternates on HTML pages via head link tags and a Link header (gated
// on HTML_HINTS). Adds Vary: Accept to HTML so shared caches don't serve
// markdown to browsers or HTML to agents once content negotiation is in play.
async function passthrough(request, cfg, pathname) {
  const response = await fetch(request);
  if ((request.method !== "GET" && request.method !== "HEAD") || response.status !== 200) return response;
  if (!(response.headers.get("content-type") || "").includes("text/html")) return response;

  const mdHref = cfg.htmlHints ? await markdownAlternate(cfg, request.url, pathname) : null;
  const rewritten = cfg.htmlHints
    ? new HTMLRewriter().on("head", new HeadHints(mdHref)).transform(response)
    : response;

  const headers = new Headers(rewritten.headers);
  headers.append("vary", "Accept");
  if (cfg.htmlHints) {
    const links = [];
    if (mdHref) links.push(`<${mdHref}>; rel="alternate"; type="text/markdown"`);
    links.push(`</llms.txt>; rel="alternate"; type="text/plain"`);
    headers.set("link", links.join(", "));
  }
  return new Response(rewritten.body, { status: rewritten.status, statusText: rewritten.statusText, headers });
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
    if (pathname.endsWith(".md") && !pathname.startsWith("/access/")) {
      const cfg = config(env);
      const response = await markdownResponse(cfg, url, request.url);
      return response || new Response(`No published note at /${pageName(pathname)}\n`, { status: 404 });
    }

    // Content negotiation: an agent requesting markdown for a page URL gets the
    // note's source. Misses (assets, unpublished paths) fall through to
    // passthrough rather than 404ing, unlike the explicit .md route.
    if (request.method === "GET" && !pathname.startsWith("/access/") &&
        (request.headers.get("accept") || "").includes("text/markdown")) {
      const cfg = config(env);
      const response = await markdownResponse(cfg, url, request.url);
      if (response) return response;
    }

    return passthrough(request, config(env), pathname);
  },
};
