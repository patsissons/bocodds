// Fetches /api/odds once on load and renders. No polling: a browser refresh
// is the refresh. All math beyond formatting happens server-side.

import {
  SOURCE_NAMES,
  SOURCE_ORDER,
  el,
  fullDate,
  legend,
  longDate,
  pct,
  relativeDays,
  stripRow,
  timeOf,
} from './shared.js';

const BOC_KEY_RATE_URL =
  'https://www.bankofcanada.ca/core-functions/monetary-policy/key-interest-rate/';

function renderHeaderMeta(data) {
  const parts = [];
  if (data.current_rate.value !== null) {
    const asOf = data.current_rate.as_of ? ` (as of ${longDate(data.current_rate.as_of)})` : '';
    parts.push(`Current policy rate: ${data.current_rate.value.toFixed(2)}%${asOf}.`);
  }
  if (data.next_meeting) {
    parts.push(
      `Next decision: ${longDate(data.next_meeting)}, 09:45 ET, ${relativeDays(data.next_meeting)}.`,
    );
  }
  const meta = document.getElementById('header-meta');
  meta.textContent = parts.join(' ');
  meta.hidden = parts.length === 0;
}

function divergenceFlag(meeting) {
  const { divergence, sources } = meeting;
  if (!divergence.flagged || !divergence.note) return null;
  const values = Object.values(sources)
    .filter((s) => s.status === 'ok' && s.rollup)
    .map((s) => s.rollup[divergence.note]);
  const low = pct(Math.min(...values));
  const high = pct(Math.max(...values));
  return el('span', {
    class: 'divergence-flag',
    text: `sources disagree on ${divergence.note}: ${low} vs ${high}`,
  });
}

function sourceStatusTag(block) {
  if (block.status === 'stale' && block.fetched_at) {
    return el('span', { class: 'status-tag', text: `as of ${timeOf(block.fetched_at)}` });
  }
  return null;
}

function outcomeContext(source, outcome) {
  const parts = [];
  if (source === 'polymarket') {
    if (outcome.volume !== undefined)
      parts.push(`$${Math.round(outcome.volume).toLocaleString()} vol`);
    if (outcome.liquidity !== undefined)
      parts.push(`$${Math.round(outcome.liquidity).toLocaleString()} liq`);
  } else if (source === 'kalshi' && outcome.volume !== undefined) {
    parts.push(`${Math.round(outcome.volume).toLocaleString()} vol`);
  }
  return parts.join(' · ');
}

function sourceDetail(source, block) {
  const heading = el(
    'h3',
    {},
    el('a', { href: block.url, text: SOURCE_NAMES[source] }),
    sourceStatusTag(block),
  );
  const detail = el('div', { class: 'source-detail' }, heading);

  const showNumbers = (block.status === 'ok' || block.status === 'stale') && block.outcomes;
  if (showNumbers) {
    const list = el('ul', { class: 'outcome-list' });
    for (const outcome of block.outcomes) {
      const context = outcomeContext(source, outcome);
      list.append(
        el(
          'li',
          {},
          el(
            'span',
            {},
            document.createTextNode(outcome.label),
            context ? el('span', { class: 'outcome-context', text: ` · ${context}` }) : null,
          ),
          el('span', { class: 'num', text: pct(outcome.probability, 1) }),
        ),
      );
    }
    detail.append(list);
    if (source === 'bocodds') {
      if (block.last_updated_text) {
        detail.append(
          el('p', { class: 'source-note', text: `Last updated ${block.last_updated_text}.` }),
        );
      }
      detail.append(
        el(
          'p',
          { class: 'attribution' },
          document.createTextNode('Data: '),
          el('a', { href: block.url, text: 'BankofCanadaOdds.com' }),
        ),
      );
    }
  } else {
    const fallbacks = {
      degraded: `${SOURCE_NAMES[source]} published numbers that failed validation, so they aren't shown.`,
      disabled: `${SOURCE_NAMES[source]} isn't shown yet.`,
      unavailable: `${SOURCE_NAMES[source]} didn't respond.`,
    };
    detail.append(
      el('p', { class: 'source-note', text: block.note || fallbacks[block.status] || '' }),
    );
  }
  return detail;
}

function meetingSection(meeting, index, animate) {
  const section = el('section', { class: index === 0 ? 'meeting' : 'meeting secondary' });
  const heading = el('h2', { text: fullDate(meeting.date) });
  const flag = divergenceFlag(meeting);
  if (flag) heading.append(flag);
  section.append(heading);
  section.append(
    el('p', {
      class: 'meeting-sub',
      text: `Announcement at ${meeting.time_et} ET, ${relativeDays(meeting.date)}`,
    }),
  );

  const strip = el('div', { class: 'strip' });
  let bars = 0;
  for (const source of SOURCE_ORDER) {
    const block = meeting.sources[source];
    if (!block || !block.rollup || !(block.status === 'ok' || block.status === 'stale')) continue;
    strip.append(...stripRow(source, block, animate));
    bars += 1;
  }
  if (bars > 0) {
    section.append(strip, legend());
  }

  const details = el('div', { class: 'details' });
  for (const source of SOURCE_ORDER) {
    const block = meeting.sources[source];
    if (block) details.append(sourceDetail(source, block));
  }
  section.append(details);
  return section;
}

function scheduleSection(schedule) {
  const list = el('ul');
  for (const item of schedule) {
    list.append(
      el(
        'li',
        {},
        el('a', {
          href: BOC_KEY_RATE_URL,
          class: 'num',
          text: `${fullDate(item.date)}, ${item.time_et} ET`,
        }),
      ),
    );
  }
  return el(
    'section',
    { class: 'schedule', 'aria-labelledby': 'schedule-heading' },
    el('h2', { id: 'schedule-heading', text: 'Remaining decision dates' }),
    list,
  );
}

function render(data) {
  const animate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  renderHeaderMeta(data);
  const content = document.getElementById('content');
  content.replaceChildren();
  data.meetings.forEach((meeting, index) => {
    content.append(meetingSection(meeting, index, animate));
  });
  if (data.schedule.length > 0) content.append(scheduleSection(data.schedule));
}

async function main() {
  const loading = document.getElementById('loading');
  try {
    const response = await fetch('/api/odds');
    if (!response.ok) throw new Error(`API responded ${response.status}`);
    render(await response.json());
  } catch {
    document.getElementById('error').hidden = false;
  } finally {
    loading.hidden = true;
  }
}

main();
