// ABOUTME: The shared activity event list — an <ol> of toned event rows. Used by both the Mission
// ABOUTME: feed (ActivityFeed) and the run drill-in (RunDetail); callers own their own empty state.

import { relativeTime, eventTone } from '@/lib/ui';
import type { FeedEvent } from '@/lib/useActivityFeed';

export function EventList({ events }: { events: FeedEvent[] }) {
  return (
    <ol className="mc-feed">
      {events.map((e) => (
        <li className="mc-ev" data-tone={eventTone(e.level, e.type)} key={e.id}>
          <span className="mc-ev-time" title={e.createdAt}>{relativeTime(e.createdAt)}</span>
          <span className="sig-dot" aria-hidden="true" />
          <span className="mc-ev-body">
            <span className="mc-ev-summary">{e.summary}</span>
            <span className="mc-ev-meta">
              <span className="mc-ev-type">{e.type}</span> · {e.actorLabel}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}
