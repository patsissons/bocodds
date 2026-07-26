// GET /og.png — the social card, rendered from the latest KV snapshot so
// link previews show real percentages for the upcoming decision. This route
// shadows the static public/og.png, which remains the fallback whenever
// there is no snapshot or rendering fails.
//
// workers-og (Satori + resvg WASM) is the project's only runtime npm
// dependency; it is bundled into the Functions worker only — the page
// payload is unchanged. Satori supports flexbox layout and TTF/OTF/WOFF
// fonts (not woff2), hence the .woff copies under public/fonts.

import { ImageResponse } from 'workers-og';
import { ogSummary, type OgSummary } from '../lib/og';
import type { Direction, Rollup, Snapshot } from '../lib/snapshot';

interface Env {
  SNAPSHOTS?: KVNamespace;
  ASSETS: Fetcher;
}

const SNAPSHOT_KEY = 'snapshot:latest';
const DIRECTIONS: Direction[] = ['cut', 'hold', 'hike'];
const COLORS: Record<Direction, string> = { cut: '#2f6fb2', hold: '#14684b', hike: '#a63a2e' };
const INK = '#1a1d21';
const MUTED = '#6b7280';
const SHORT_LABELS: Record<string, string> = { bocodds: 'BankofCanadaOdds' };

interface OgFont {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 600;
  style: 'normal';
}

// Fonts are static assets; cache the fetch across requests in this isolate.
let fontsPromise: Promise<OgFont[]> | null = null;

function loadFonts(assets: Fetcher, origin: string): Promise<OgFont[]> {
  fontsPromise ??= Promise.all(
    ([400, 600] as const).map(async (weight): Promise<OgFont> => {
      const response = await assets.fetch(`${origin}/fonts/ibm-plex-sans-latin-${weight}.woff`);
      if (!response.ok) throw new Error(`font fetch failed: ${response.status}`);
      return { name: 'IBM Plex Sans', data: await response.arrayBuffer(), weight, style: 'normal' };
    }),
  ).catch((error: unknown) => {
    fontsPromise = null; // don't cache a failure
    throw error;
  });
  return fontsPromise;
}

function pctText(probability: number): string {
  return `${Math.round(probability * 100)}%`;
}

function barMarkup(rollup: Rollup): string {
  const visible = DIRECTIONS.filter((d) => rollup[d] >= 0.005);
  const segments = visible
    .map((direction, index) => {
      const gap = index < visible.length - 1 ? 'margin-right:4px;' : '';
      // flex-grow gives proportional widths without a fixed-width parent.
      return `<div style="display:flex;flex-grow:${Math.round(rollup[direction] * 1000)};height:36px;background:${COLORS[direction]};${gap}"></div>`;
    })
    .join('');
  return `<div style="display:flex;flex:1;height:36px;">${segments}</div>`;
}

function rowMarkup(label: string, rollup: Rollup): string {
  return `
    <div style="display:flex;align-items:center;margin-top:24px;">
      <div style="display:flex;width:290px;justify-content:flex-end;padding-right:28px;font-size:27px;color:${MUTED};">${label}</div>
      ${barMarkup(rollup)}
      <div style="display:flex;width:170px;justify-content:flex-end;font-size:27px;font-weight:600;color:${INK};">hold ${pctText(rollup.hold)}</div>
    </div>`;
}

function legendMarkup(): string {
  return `<div style="display:flex;">${DIRECTIONS.map(
    (direction) =>
      `<div style="display:flex;align-items:center;margin-right:36px;font-size:26px;color:${MUTED};">
        <div style="display:flex;width:18px;height:18px;border-radius:4px;background:${COLORS[direction]};margin-right:12px;"></div>${direction}
      </div>`,
  ).join('')}</div>`;
}

function markup(summary: OgSummary): string {
  const averages = [...DIRECTIONS]
    .sort((a, b) => summary.rollup[b] - summary.rollup[a])
    .map((direction) => `${direction} ${pctText(summary.rollup[direction])}`)
    .join(', ');
  const rows = summary.perSource
    .map((row) => rowMarkup(SHORT_LABELS[row.source] ?? row.label, row.rollup))
    .join('');
  return `
    <div style="display:flex;flex-direction:column;justify-content:space-between;width:1200px;height:630px;background:#fafaf7;color:${INK};padding:64px 80px;font-family:'IBM Plex Sans';">
      <div style="display:flex;flex-direction:column;">
        <div style="display:flex;font-size:58px;font-weight:600;letter-spacing:-1px;">BoC Rate Odds</div>
        <div style="display:flex;font-size:31px;color:${MUTED};margin-top:12px;">${summary.longDate} decision — ${averages} on average</div>
      </div>
      <div style="display:flex;flex-direction:column;">${rows}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;border-top:2px solid #e4e4de;padding-top:26px;">
        ${legendMarkup()}
        <div style="display:flex;font-size:28px;font-weight:600;">bocodds.com</div>
      </div>
    </div>`;
}

function staticFallback(assets: Fetcher, origin: string): Promise<Response> {
  // The ASSETS binding serves the raw static file — it never re-enters
  // this function, so this cannot recurse.
  return assets.fetch(`${origin}/og.png`);
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const origin = new URL(context.request.url).origin;
  try {
    const cached = await context.env.SNAPSHOTS?.get(SNAPSHOT_KEY);
    const summary = cached ? ogSummary(JSON.parse(cached) as Snapshot) : null;
    if (!summary) return await staticFallback(context.env.ASSETS, origin);

    const fonts = await loadFonts(context.env.ASSETS, origin);
    const image = new ImageResponse(markup(summary), { width: 1200, height: 630, fonts });
    const response = new Response(image.body, image);
    response.headers.set('Content-Type', 'image/png');
    response.headers.set('Cache-Control', 'public, max-age=900');
    return response;
  } catch (error) {
    console.error('og.png render failed:', String(error));
    return staticFallback(context.env.ASSETS, origin);
  }
};
