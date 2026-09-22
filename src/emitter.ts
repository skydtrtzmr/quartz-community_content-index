import path from "node:path";
import fs from "node:fs/promises";
import type { Root } from "hast";
import type {
  GlobalConfiguration,
  QuartzEmitterPlugin,
  BuildCtx,
  FilePath,
  FullSlug,
  QuartzPluginData,
  ProcessedContent,
  SimpleSlug,
} from "@quartz-community/types";
import { joinSegments } from "@quartz-community/types";
import { simplifySlug, escapeHTML } from "@quartz-community/utils";
import { getDate } from "@quartz-community/utils/sort";
import { toHtml } from "hast-util-to-html";

export type ContentIndexMap = Map<FullSlug, ContentDetails>;
export type ContentDetails = {
  slug: FullSlug;
  filePath: FilePath;
  title: string;
  links: SimpleSlug[];
  tags: string[];
  content: string;
  richContent?: string;
  date?: Date;
  description?: string;
  /** Page frontmatter, kept for field-based (e.g. `@key:value`) client-side search. */
  frontmatter?: Record<string, unknown>;
};

interface Options {
  enableSiteMap: boolean;
  enableRSS: boolean;
  rssLimit?: number;
  rssFullHtml: boolean;
  rssSlug: string;
  includeEmptyFiles: boolean;
  rssRecentNotesText?: string;
  rssLastFewNotesText?: (count: number) => string;
}

const defaultOptions: Options = {
  enableSiteMap: true,
  enableRSS: true,
  rssLimit: 10,
  rssFullHtml: false,
  rssSlug: "index",
  includeEmptyFiles: true,
  rssRecentNotesText: "Recent notes",
  rssLastFewNotesText: (count) => `Last ${count} notes`,
};

const write = async (args: {
  ctx: BuildCtx;
  content: string;
  slug: FullSlug;
  ext: string;
}): Promise<FilePath> => {
  const pathToPage = joinSegments(args.ctx.argv.output, args.slug + args.ext) as FilePath;
  const dir = path.dirname(pathToPage);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(pathToPage, args.content);
  return pathToPage;
};

function generateSiteMap(cfg: GlobalConfiguration, idx: ContentIndexMap): string {
  const base = cfg.baseUrl ?? "";
  const createURLEntry = (slug: SimpleSlug, content: ContentDetails): string => `<url>
    <loc>https://${joinSegments(base, encodeURI(slug))}</loc>
    ${content.date && `<lastmod>${content.date.toISOString()}</lastmod>`}
  </url>`;
  const urls = Array.from(idx)
    .map(([slug, content]) => createURLEntry(simplifySlug(slug) as SimpleSlug, content))
    .join("");
  return `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${urls}</urlset>`;
}

function generateRSSFeed(
  cfg: GlobalConfiguration,
  idx: ContentIndexMap,
  options: Options,
  limit?: number,
): string {
  const base = cfg.baseUrl ?? "";
  const pageTitle = cfg.pageTitle ?? "";
  const recentNotesText = options.rssRecentNotesText ?? "Recent notes";
  const lastFewNotesText =
    options.rssLastFewNotesText ?? ((count: number) => `Last ${count} notes`);

  const createURLEntry = (slug: SimpleSlug, content: ContentDetails): string => `<item>
    <title>${escapeHTML(content.title)}</title>
    <link>https://${joinSegments(base, encodeURI(slug))}</link>
    <guid>https://${joinSegments(base, encodeURI(slug))}</guid>
    <description><![CDATA[ ${content.richContent ?? content.description} ]]></description>
    <pubDate>${content.date?.toUTCString()}</pubDate>
  </item>`;

  const items = Array.from(idx)
    .sort(([_, f1], [__, f2]) => {
      if (f1.date && f2.date) {
        return f2.date.getTime() - f1.date.getTime();
      } else if (f1.date && !f2.date) {
        return -1;
      } else if (!f1.date && f2.date) {
        return 1;
      }

      return f1.title.localeCompare(f2.title);
    })
    .map(([slug, content]) => createURLEntry(simplifySlug(slug) as SimpleSlug, content))
    .slice(0, limit ?? idx.size)
    .join("");

  const description = `${
    limit ? lastFewNotesText(limit) : recentNotesText
  } on ${escapeHTML(pageTitle)}`;

  return `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
    <channel>
      <title>${escapeHTML(pageTitle)}</title>
      <link>https://${base}</link>
      <description>${description}</description>
      <generator>Quartz -- quartz.jzhao.xyz</generator>
      ${items}
    </channel>
  </rss>`;
}

export const ContentIndex: QuartzEmitterPlugin<Partial<Options>> = (opts) => {
  const options = { ...defaultOptions, ...opts };
  const emitAll = async (ctx: BuildCtx, content: ProcessedContent[]): Promise<FilePath[]> => {
    const cfg = ctx.cfg.configuration;
    const linkIndex: ContentIndexMap = new Map();
    for (const [tree, file] of content) {
      const data = (file.data as Record<string, unknown>) ?? {};
      if (data.unlisted === true) continue;
      const slug = data.slug as FullSlug;
      const date = getDate(data as QuartzPluginData) ?? new Date();
      const text = data.text as string | undefined;
      if (options.includeEmptyFiles || (text && text !== "")) {
        const frontmatter = (data.frontmatter as Record<string, unknown> | undefined) ?? {};
        const isEncrypted = data.encrypted === true;
        linkIndex.set(slug, {
          slug,
          filePath: data.relativePath as FilePath,
          title: (frontmatter.title as string) ?? "",
          links: (data.links as SimpleSlug[] | undefined) ?? [],
          tags: (frontmatter.tags as string[] | undefined) ?? [],
          content: text ?? "",
          richContent:
            options.rssFullHtml && !isEncrypted
              ? escapeHTML(toHtml(tree as Root, { allowDangerousHtml: true }))
              : undefined,
          date: date,
          description: (data.description as string | undefined) ?? "",
          frontmatter,
        });
      }
    }

    const outputs: FilePath[] = [];
    if (options.enableSiteMap) {
      outputs.push(
        await write({
          ctx,
          content: generateSiteMap(cfg, linkIndex),
          slug: "sitemap" as FullSlug,
          ext: ".xml",
        }),
      );
    }

    if (options.enableRSS) {
      outputs.push(
        await write({
          ctx,
          content: generateRSSFeed(cfg, linkIndex, options, options.rssLimit),
          slug: (options.rssSlug ?? "index") as FullSlug,
          ext: ".xml",
        }),
      );
    }

    const fp = joinSegments("static", "contentIndex") as unknown as FullSlug;
    const simplifiedIndex = Object.fromEntries(
      Array.from(linkIndex).map(([slug, content]) => {
        delete content.description;
        delete content.date;
        return [slug, content];
      }),
    );

    outputs.push(
      await write({
        ctx,
        content: JSON.stringify(simplifiedIndex),
        slug: fp,
        ext: ".json",
      }),
    );

    // static/metadata.json：构建时间戳，供前端组件（如 explorer-pro）作废 sessionStorage 缓存。
    // v5 页面不注入 fetchMetadata 全局，组件改为自行 fetch 该文件。
    const metaFp = joinSegments("static", "metadata") as unknown as FullSlug;
    outputs.push(
      await write({
        ctx,
        content: JSON.stringify({ lastBuildTime: Date.now() }),
        slug: metaFp,
        ext: ".json",
      }),
    );

    return outputs;
  };

  return {
    name: "ContentIndex",
    emit: (ctx, content) => emitAll(ctx, content),
    // RSS auto-discovery link tag should be added via a component plugin or manually in the layout.
    // content 是当前发布集合（含插件生成页），changeEvents 仅含源文件变化。
    // 正文沿用磁盘基线；成员增删以 content 为准，避免遗留虚拟页或过滤掉的页。
    async *partialEmit(ctx, content, _resources, changeEvents) {
      console.log("ContentIndex: partialEmit");

      const cfg = ctx.cfg.configuration;
      const fp = joinSegments("static", "contentIndex") as unknown as FullSlug;
      const contentIndexPath = joinSegments(ctx.argv.output, "static", "contentIndex.json");
      let existingIndex: Record<string, ContentDetails> = {};

      try {
        const existingContent = await fs.readFile(contentIndexPath, "utf-8");
        existingIndex = JSON.parse(existingContent) as Record<string, ContentDetails>;
        console.log(
          `ContentIndex: Loaded existing index with ${Object.keys(existingIndex).length} entries`,
        );
      } catch (error) {
        throw new Error(
          "ContentIndex: incremental baseline is missing or invalid; rebuild with --reset",
          {
            cause: error,
          },
        );
      }

      const currentSlugs = new Set(content.map(([, file]) => file.data.slug));
      // v5 dispatcher 扩展的标准生成页集合；兼容尚未声明它的社区类型包。
      const virtualPages =
        (ctx as BuildCtx & { virtualPages?: ProcessedContent[] }).virtualPages ?? [];
      const generatedSlugs = new Set(virtualPages.map(([, file]) => file.data.slug));
      const changedSlugs = new Set(changeEvents.map((event) => event.file?.data.slug));
      for (const slug of Object.keys(existingIndex)) {
        if (!currentSlugs.has(slug as FullSlug)) {
          delete existingIndex[slug];
        }
      }

      for (const [tree, file] of content) {
        const data = (file.data as Record<string, unknown>) ?? {};
        const slug = data.slug as FullSlug;
        const text = data.text as string | undefined;
        const frontmatter = (data.frontmatter as Record<string, unknown> | undefined) ?? {};

        if (data.unlisted === true) {
          delete existingIndex[slug];
          continue;
        }

        // SQLite 未变更页只恢复元数据，不能拿空正文覆盖完整的搜索索引。
        if (text === undefined && !changedSlugs.has(slug) && !generatedSlugs.has(slug)) {
          if (!existingIndex[slug] && options.includeEmptyFiles) {
            throw new Error(`ContentIndex: baseline is missing ${slug}; rebuild with --reset`);
          }
          continue;
        }
        if (!options.includeEmptyFiles && !text) {
          delete existingIndex[slug];
          continue;
        }

        const isEncrypted = data.encrypted === true;
        existingIndex[slug] = {
          slug,
          filePath: data.relativePath as FilePath,
          title: (frontmatter.title as string) ?? slug,
          links: (data.links as SimpleSlug[] | undefined) ?? [],
          tags: (frontmatter.tags as string[] | undefined) ?? [],
          content: text ?? "",
          richContent:
            options.rssFullHtml && !isEncrypted && tree
              ? escapeHTML(toHtml(tree as Root, { allowDangerousHtml: true }))
              : undefined,
          frontmatter,
        };
        console.log(`ContentIndex: Updated ${slug}`);
      }

      console.log(`ContentIndex: Final index has ${Object.keys(existingIndex).length} entries`);

      const metaFp = joinSegments("static", "metadata") as unknown as FullSlug;
      yield write({
        ctx,
        content: JSON.stringify({ lastBuildTime: Date.now() }),
        slug: metaFp,
        ext: ".json",
      });

      yield write({
        ctx,
        content: JSON.stringify(existingIndex),
        slug: fp,
        ext: ".json",
      });

      if (options.enableSiteMap || options.enableRSS) {
        const linkIndex: ContentIndexMap = new Map();
        for (const [slug, details] of Object.entries(existingIndex)) {
          linkIndex.set(slug as FullSlug, { ...details, date: new Date() });
        }

        if (options.enableSiteMap) {
          yield write({
            ctx,
            content: generateSiteMap(cfg, linkIndex),
            slug: "sitemap" as FullSlug,
            ext: ".xml",
          });
        }

        if (options.enableRSS) {
          yield write({
            ctx,
            content: generateRSSFeed(cfg, linkIndex, options, options.rssLimit),
            slug: (options.rssSlug ?? "index") as FullSlug,
            ext: ".xml",
          });
        }
      }
    },
  };
};
