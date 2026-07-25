// Fetches /api/odds once on load and renders. No polling: a browser refresh
// is the refresh. All math beyond formatting happens server-side.

const SOURCE_ORDER = ['kalshi', 'polymarket', 'bocodds'];
const SOURCE_NAMES = {
  kalshi: 'Kalshi',
  polymarket: 'Polymarket',
  bocodds: 'BankofCanadaOdds.com',
};
const DIRECTIONS = ['cut', 'hold', 'hike'];
const BOC_KEY_RATE_URL =
  'https://www.bankofcanada.ca/core-functions/monetary-policy/key-interest-rate/';

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(child);
  }
  return node;
}

function pct(probability, digits = 0) {
  return `${(probability * 100).toFixed(digits)}%`;
}

function localDate(iso) {
  return new Date(`${iso}T12:00:00`);
}

function longDate(iso) {
  return localDate(iso).toLocaleDateString('en-CA', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

function fullDate(iso) {
  return localDate(iso).toLocaleDateString('en-CA', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function daysUntil(iso) {
  const oneDay = 24 * 60 * 60 * 1000;
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  return Math.round((localDate(iso) - today) / oneDay);
}

function relativeDays(iso) {
  const days = daysUntil(iso);
  return days === 0 ? 'today' : days === 1 ? 'in 1 day' : `in ${days} days`;
}

function timeOf(isoTimestamp) {
  return new Date(isoTimestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

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

function stripRow(source, block, animate) {
  const label = el('a', {
    class: 'strip-source',
    href: block.url,
    text: SOURCE_NAMES[source],
  });

  const description = DIRECTIONS.map((d) => `${d} ${pct(block.rollup[d])}`).join(', ');
  const bar = el('div', {
    class: 'bar',
    role: 'img',
    'aria-label': `${SOURCE_NAMES[source]}: ${description}`,
  });
  for (const direction of DIRECTIONS) {
    const share = block.rollup[direction];
    if (share < 0.005) continue;
    const seg = el('div', { class: `seg ${direction}`, title: `${direction} ${pct(share)}` });
    const width = `${(share * 100).toFixed(2)}%`;
    if (animate) {
      seg.style.width = '0%';
      requestAnimationFrame(() => requestAnimationFrame(() => (seg.style.width = width)));
    } else {
      seg.style.width = width;
    }
    bar.append(seg);
  }

  const hold = el('span', {
    class: 'strip-hold num',
    text: `hold ${pct(block.rollup.hold)}`,
  });
  return [label, bar, hold];
}

function legend() {
  return el(
    'ul',
    { class: 'strip-legend', 'aria-hidden': 'true' },
    ...DIRECTIONS.map((d) =>
      el('li', {}, el('span', { class: `swatch seg ${d}` }), document.createTextNode(d)),
    ),
  );
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
