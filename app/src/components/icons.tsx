// app/src/components/icons.tsx — Fibb's icon set: rounded strokes over a soft tinted fill ("duotone"),
// so every icon reads as part of one family at any size.
import type { JSX, ReactNode } from 'react';

const T = { fill: 'currentColor', fillOpacity: 0.16, stroke: 'none' } as const;
const icon = (body: ReactNode): JSX.Element => (
  <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{body}</svg>
);

export const Ico = {
  chat: icon(<><path {...T} d="M12 3.5c-4.97 0-9 3.47-9 7.75 0 2.2 1.07 4.2 2.8 5.6L5 20.5l4.3-1.9c.87.2 1.77.3 2.7.3 4.97 0 9-3.47 9-7.65S16.97 3.5 12 3.5z" /><path d="M12 3.5c-4.97 0-9 3.47-9 7.75 0 2.2 1.07 4.2 2.8 5.6L5 20.5l4.3-1.9c.87.2 1.77.3 2.7.3 4.97 0 9-3.47 9-7.65S16.97 3.5 12 3.5z" /><path d="M8.5 11.3h.01M12 11.3h.01M15.5 11.3h.01" strokeWidth="2.4" /></>),
  book: icon(<><path {...T} d="M5 4.5A2.5 2.5 0 0 1 7.5 2H19v16H7.5A2.5 2.5 0 0 0 5 20.5z" /><path d="M5 20.5A2.5 2.5 0 0 1 7.5 18H19V2H7.5A2.5 2.5 0 0 0 5 4.5v16A1.5 1.5 0 0 0 6.5 22H19" /><path d="M9.5 7h5.5" /></>),
  tasks: icon(<><rect {...T} x="3.5" y="3.5" width="17" height="17" rx="5" /><rect x="3.5" y="3.5" width="17" height="17" rx="5" /><path d="m8.3 12.3 2.6 2.6 4.9-5.4" /></>),
  idea: icon(<><path {...T} d="M12 2.5a6.5 6.5 0 0 0-3.8 11.8c.5.4.8 1 .8 1.7h6c0-.7.3-1.3.8-1.7A6.5 6.5 0 0 0 12 2.5z" /><path d="M12 2.5a6.5 6.5 0 0 0-3.8 11.8c.5.4.8 1 .8 1.7h6c0-.7.3-1.3.8-1.7A6.5 6.5 0 0 0 12 2.5z" /><path d="M9.5 19.5h5M10.5 22h3" /></>),
  settings: icon(<><circle {...T} cx="9" cy="7" r="3" /><circle {...T} cx="15" cy="17" r="3" /><path d="M3.5 7H6M12 7h8.5M3.5 17H12M18 17h2.5" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></>),
  search: icon(<><circle {...T} cx="11" cy="11" r="7" /><circle cx="11" cy="11" r="7" /><path d="m20.5 20.5-4.3-4.3" /></>),
  speaker: icon(<><path {...T} d="M11.5 4.5 6.5 8.5H3.5v7h3l5 4z" /><path d="M11.5 4.5 6.5 8.5H3.5v7h3l5 4z" /><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18.3 6.2a8.2 8.2 0 0 1 0 11.6" /></>),
  wave: icon(<path d="M3.5 10.5v3M7.75 6.5v11M12 3.5v17M16.25 7.5v9M20.5 10.5v3" strokeWidth="2.1" />),
  moon: icon(<><path {...T} d="M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.8 6.8 0 0 0 9.7 9.7z" /><path d="M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.8 6.8 0 0 0 9.7 9.7z" /></>),
  sun: icon(<><circle {...T} cx="12" cy="12" r="4.2" /><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.5 12h2M19.5 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>),
  auto: icon(<><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5a8.5 8.5 0 0 0 0 17z" fill="currentColor" stroke="none" /></>),
  mic: icon(<><rect {...T} x="8.5" y="2.5" width="7" height="12" rx="3.5" /><rect x="8.5" y="2.5" width="7" height="12" rx="3.5" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5" /></>),
  send: icon(<path d="M12 19.5V5M5.5 11.5 12 5l6.5 6.5" strokeWidth="2.3" />),
  pen: icon(<><path {...T} d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7.5 18.5l-4 1 1-4z" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7.5 18.5l-4 1 1-4z" /><path d="M13 20h7.5" /></>),
  spark: icon(<><path {...T} d="M11 3.5l1.9 5.1L18 10.5l-5.1 1.9L11 17.5l-1.9-5.1L4 10.5l5.1-1.9z" /><path d="M11 3.5l1.9 5.1L18 10.5l-5.1 1.9L11 17.5l-1.9-5.1L4 10.5l5.1-1.9z" /><path d="M18.5 16v4M16.5 18h4" /></>),
  help: icon(<><circle {...T} cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="8.5" /><path d="M9.7 9.4a2.4 2.4 0 1 1 3.4 2.2c-.7.4-1.1 1-1.1 1.7M12 16.7h.01" /></>),
  chapter: icon(<><path {...T} d="M6 3.5h9l4 4v13H6z" /><path d="M15 3.5H6v17h13v-13zM15 3.5v4h4M9.5 12.5h6M9.5 16h4" /></>),
} as const;
