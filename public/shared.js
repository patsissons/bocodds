// Render helpers shared by the main page (app.js) and the iframe embed
// (embed.js). All math beyond formatting happens server-side.

export const SOURCE_ORDER = ['kalshi', 'polymarket', 'bocodds'];
export const SOURCE_NAMES = {
  kalshi: 'Kalshi',
  polymarket: 'Polymarket',
  bocodds: 'BankofCanadaOdds.com',
};
export const DIRECTIONS = ['cut', 'hold', 'hike'];

export function el(tag, attrs = {}, ...children) {
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

export function pct(probability, digits = 0) {
  return `${(probability * 100).toFixed(digits)}%`;
}

export function localDate(iso) {
  return new Date(`${iso}T12:00:00`);
}

export function longDate(iso) {
  return localDate(iso).toLocaleDateString('en-CA', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

export function fullDate(iso) {
  return localDate(iso).toLocaleDateString('en-CA', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function daysUntil(iso) {
  const oneDay = 24 * 60 * 60 * 1000;
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  return Math.round((localDate(iso) - today) / oneDay);
}

export function relativeDays(iso) {
  const days = daysUntil(iso);
  return days === 0 ? 'today' : days === 1 ? 'in 1 day' : `in ${days} days`;
}

export function timeOf(isoTimestamp) {
  return new Date(isoTimestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function stripRow(source, block, animate) {
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

export function legend() {
  return el(
    'ul',
    { class: 'strip-legend', 'aria-hidden': 'true' },
    ...DIRECTIONS.map((d) =>
      el('li', {}, el('span', { class: `swatch seg ${d}` }), document.createTextNode(d)),
    ),
  );
}
