// The iframe embed: one compact card for a single meeting (the next one by
// default, or ?meeting=YYYY-MM-DD). Same data path as the main page.

import { SOURCE_ORDER, el, legend, longDate, relativeDays, stripRow } from './shared.js';

async function main() {
  const heading = document.getElementById('embed-heading');
  const content = document.getElementById('embed-content');
  try {
    const response = await fetch('/api/odds');
    if (!response.ok) throw new Error(`API responded ${response.status}`);
    const data = await response.json();

    const requested = new URLSearchParams(location.search).get('meeting');
    const meeting = data.meetings.find((m) => m.date === requested) ?? data.meetings[0];
    if (!meeting) throw new Error('no upcoming meetings');

    const strip = el('div', { class: 'strip' });
    let bars = 0;
    for (const source of SOURCE_ORDER) {
      const block = meeting.sources[source];
      if (!block || !block.rollup || !(block.status === 'ok' || block.status === 'stale')) continue;
      strip.append(...stripRow(source, block, false));
      bars += 1;
    }
    if (bars === 0) throw new Error('no sources with numbers');

    heading.textContent = `BoC rate decision — ${longDate(meeting.date)}, ${relativeDays(meeting.date)}`;
    content.replaceChildren(strip, legend());
  } catch {
    content.replaceChildren(
      el('p', { class: 'embed-error', text: 'The odds are unavailable right now.' }),
    );
  }
}

main();
