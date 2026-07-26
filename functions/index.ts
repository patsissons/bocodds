// GET / — serves the static index.html with the <title>, description, and
// OG/Twitter meta rewritten from the latest KV snapshot, so link previews
// show the upcoming decision date and the current odds.
//
// Read-only on purpose: this never triggers an upstream refresh (link
// scrapers shouldn't cost API calls). Any failure — no snapshot, bad JSON,
// missing binding — falls back to the untouched static asset.

import { ogDescription, ogImageAlt, ogSummary, ogTitle, type OgSummary } from '../lib/og';
import type { Snapshot } from '../lib/snapshot';

interface Env {
  SNAPSHOTS?: KVNamespace;
  ASSETS: Fetcher;
}

const SNAPSHOT_KEY = 'snapshot:latest';

function setContent(content: string) {
  return {
    element(element: Element) {
      element.setAttribute('content', content);
    },
  };
}

function rewriteMeta(asset: Response, summary: OgSummary, origin: string): Response {
  const title = ogTitle(summary);
  const description = ogDescription(summary);
  const imageUrl = `${origin}/og.png?v=${summary.version}`;

  const rewritten = new HTMLRewriter()
    .on('title', {
      element(element: Element) {
        element.setInnerContent(title);
      },
    })
    .on('meta[name="description"]', setContent(description))
    .on('meta[property="og:title"]', setContent(title))
    .on('meta[property="og:description"]', setContent(description))
    .on('meta[property="og:image"]', setContent(imageUrl))
    .on('meta[property="og:image:alt"]', setContent(ogImageAlt(summary)))
    .on('meta[name="twitter:title"]', setContent(title))
    .on('meta[name="twitter:description"]', setContent(description))
    .on('meta[name="twitter:image"]', setContent(imageUrl))
    .transform(asset);

  const response = new Response(rewritten.body, rewritten);
  response.headers.set('Cache-Control', 'public, max-age=60');
  return response;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const asset = await context.env.ASSETS.fetch(context.request);
  try {
    const cached = await context.env.SNAPSHOTS?.get(SNAPSHOT_KEY);
    if (!cached) return asset;
    const summary = ogSummary(JSON.parse(cached) as Snapshot);
    if (!summary) return asset;
    return rewriteMeta(asset, summary, new URL(context.request.url).origin);
  } catch {
    return asset;
  }
};
