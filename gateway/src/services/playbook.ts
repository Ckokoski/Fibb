/**
 * The playbook: a curated list of concrete things Fibb can do for an author.
 *
 * Pure data and pure functions. NoticeService offers one play as a suggestion
 * when it has nothing usage-based to say, and the app can list and run them on
 * demand (see api/routes/playbook.ts).
 *
 * Templates may use `{book}`. It becomes the book's title when one is known.
 * Otherwise it reads "your book" in text shown to the author, "my book" in
 * text the author would say, and "their current book" in work orders.
 */

export type PlayNeed = 'book' | 'google' | 'browser';
export type PlayCategory = 'Story' | 'Research' | 'Marketing' | 'Routine' | 'Email and calendar';

export type PlayAction =
  | { kind: 'task'; title: string; detail: string }
  | { kind: 'schedule'; title: string; detail: string; cron: string }
  | { kind: 'say'; say: string };

export interface Play {
  id: string;
  category: PlayCategory;
  title: string;
  /** One sentence saying what Fibb would do. */
  blurb: string;
  needs: PlayNeed[];
  /** Button label. */
  label: string;
  action: PlayAction;
}

export interface PlayContext { bookTitle?: string; chapter?: number; hasGoogle: boolean; hasBrowser: boolean }

export const PLAY_CATEGORIES: PlayCategory[] = ['Story', 'Research', 'Marketing', 'Routine', 'Email and calendar'];

// ── Shared parts of the work orders ──

const SOURCES =
  'Work from the manuscript, notes and memory you have for {book}. ' +
  "If Google is connected, search the author's Google Drive for the manuscript and notes first, and read what you find before you start.";
const DRIVE_FIRST =
  "Search the author's Google Drive for the manuscript and notes first, and read what you find before you start.";
const BROWSE =
  'Use your browser to look things up and cite the page titles and addresses you used. If the browser is not available, say so at the top and mark every claim you could not check.';
const FINISH =
  'Deliver one finished Markdown document with clear headings, ready to read as it is. ' +
  'Do not invent details that are not in the material. ' +
  'End with a section titled "Questions for you" that lists anything you could not confirm, rather than guessing.';
const SHORT_FINISH =
  'Write it in Markdown, warm and plain, with no headings. If there is nothing to go on, say so in one line and end with "Questions for you" and the one thing you need to know.';

const order = (...parts: string[]): string => parts.join('\n\n');

// ── The plays ──

export const PLAYS: Play[] = [
  // ── Story ──
  {
    id: 'consistency-check',
    category: 'Story',
    title: 'Check the story for contradictions',
    blurb: 'I can comb {book} for contradictions in names, ages, eye colors, dates and places.',
    needs: ['book'],
    label: 'Check it',
    action: {
      kind: 'task',
      title: 'Consistency check: {book}',
      detail: order(
        'Run a story consistency check on {book}.',
        SOURCES,
        'Check these, chapter by chapter: character names and their spellings, ages and birthdays, eye and hair colors and other physical details, the timeline (dates, days of the week, seasons, how long things take), places and distances, and who knows what at each point in the story.',
        'Report a Markdown table of contradictions with these columns: What conflicts, First appearance (chapter and a short quote), Second appearance (chapter and a short quote), Suggested fix. Sort the most serious first. After the table, add a short list of details that are consistent but worth writing down, such as ages and eye colors, so the author has a reference.',
        FINISH,
      ),
    },
  },
  {
    id: 'plot-hole-pass',
    category: 'Story',
    title: 'Look for plot holes',
    blurb: 'I can read {book} for plot holes and loose logic and list each one with a possible fix.',
    needs: ['book'],
    label: 'Look for holes',
    action: {
      kind: 'task',
      title: 'Plot hole pass: {book}',
      detail: order(
        'Read {book} looking for plot holes.',
        SOURCES,
        'Look for: events with no cause, characters acting against what they want or know, problems that solve themselves, questions raised and never answered, things set up and never paid off, and payoffs with no setup.',
        'For each one give: where it happens (chapter), what the problem is in one or two sentences, how much it matters (small, medium or large), and one or two concrete ways to fix it with the least rewriting.',
        FINISH,
      ),
    },
  },
  {
    id: 'book-dashboard',
    category: 'Story',
    title: 'Build a one-page book dashboard',
    blurb: 'I can put the progress, cast, open threads and next steps for {book} on one page.',
    needs: ['book'],
    label: 'Build it',
    action: {
      kind: 'task',
      title: 'Book dashboard: {book}',
      detail: order(
        'Build a one-page dashboard for {book}.',
        SOURCES,
        'Sections, in this order: Progress (chapters drafted, word count if you can tell, the stage the book is in, where the author left off). Cast list (each named character in one line: role, what they want, where they stand now). Open threads (plot lines and questions still unresolved, with the chapter each one started in). Promises made to the reader (things the story has set up that it must pay off). Next three steps (the three most useful things to do next, each small enough for one sitting).',
        'Keep it to one page: short lines and small tables, no long paragraphs.',
        FINISH,
      ),
    },
  },
  {
    id: 'character-sheets',
    category: 'Story',
    title: 'Write up character sheets',
    blurb: 'I can write a sheet for each main character in {book} from what is already on the page.',
    needs: ['book'],
    label: 'Write them',
    action: {
      kind: 'task',
      title: 'Character sheets: {book}',
      detail: order(
        'Write a character sheet for each main character in {book}, using only what the text and notes already establish.',
        SOURCES,
        'For each character: full name and what others call them, age, appearance, how they speak (with one short quoted line), what they want, what they fear, their key relationships, their secrets, and where they are at the latest point in the story. Mark anything the text leaves open as "not stated yet".',
        FINISH,
      ),
    },
  },
  {
    id: 'chapter-summaries',
    category: 'Story',
    title: 'Summarize every chapter',
    blurb: 'I can write a short summary of each chapter of {book} so the whole shape is easy to see.',
    needs: ['book'],
    label: 'Summarize it',
    action: {
      kind: 'task',
      title: 'Chapter summaries: {book}',
      detail: order(
        'Write a summary of every chapter of {book} that exists so far.',
        SOURCES,
        'For each chapter give: the chapter number and title, three to five sentences on what happens, whose point of view it is in, where and when it takes place, and what changes by the end. Finish with a ten line outline of the whole book as it stands.',
        FINISH,
      ),
    },
  },
  {
    id: 'opening-line-workshop',
    category: 'Story',
    title: 'Workshop your opening line',
    blurb: 'We can try ten different opening lines for {book} together and see which one pulls hardest.',
    needs: [],
    label: 'Try it',
    action: {
      kind: 'say',
      say: 'Help me workshop the opening line of {book}. Give me ten options in different styles and tell me which one you would pick and why.',
    },
  },
  {
    id: 'title-brainstorm',
    category: 'Story',
    title: 'Brainstorm titles',
    blurb: 'I can come up with thirty title ideas for {book} and pick my five favorites with reasons.',
    needs: [],
    label: 'Brainstorm',
    action: {
      kind: 'task',
      title: 'Title ideas for {book}',
      detail: order(
        'Brainstorm titles for {book}.',
        SOURCES,
        'Give thirty title ideas in groups: plain and direct, image or object from the story, a phrase a character says, a place or time, and a few unexpected ones. Then pick your five favorites and say in one line each why it fits the story and its genre. If you have a browser, check whether each of the five is already the title of a well known book and say what you found.',
        FINISH,
      ),
    },
  },
  {
    id: 'scene-ideas',
    category: 'Story',
    title: 'Get ideas for the next scene',
    blurb: 'I can pitch five ways the next scene of {book} could go, from safe to surprising.',
    needs: [],
    label: 'Pitch me',
    action: { kind: 'say', say: 'Pitch me five ways the next scene of {book} could go, from safe to surprising.' },
  },
  {
    id: 'series-bible-start',
    category: 'Story',
    title: 'Start a series bible',
    blurb: 'I can start a series bible for {book} with the world rules, cast, timeline and running threads.',
    needs: ['book'],
    label: 'Start it',
    action: {
      kind: 'task',
      title: 'Series bible: {book}',
      detail: order(
        'Start a series bible for {book}.',
        SOURCES,
        'Sections: World rules (how things work, including any magic, technology or laws, each with the chapter that establishes it). Cast (name, role, fixed facts such as age and appearance). Places (each with a two line description and who lives there). Timeline (events in order with dates where given). Running threads (things that could carry into another book). Style notes (tense, point of view, recurring words and names to spell the same way every time).',
        FINISH,
      ),
    },
  },
  {
    id: 'pacing-check',
    category: 'Story',
    title: 'Check the pacing',
    blurb: 'I can map the pace of {book} chapter by chapter and point out where it drags or rushes.',
    needs: ['book'],
    label: 'Check it',
    action: {
      kind: 'task',
      title: 'Pacing check: {book}',
      detail: order(
        'Check the pacing of {book}.',
        SOURCES,
        'Make a table with one row per chapter: rough length, what kind of chapter it is (action, conversation, reflection, setup), how much changes for the main character, and a pace rating from 1 (slow) to 5 (fast). Below the table, name the three places where the story drags and the three where it rushes, and give one specific suggestion for each.',
        FINISH,
      ),
    },
  },
  {
    id: 'first-reader-notes',
    category: 'Story',
    title: 'Get first-reader notes on a chapter',
    blurb: 'I can read your latest chapter of {book} like a first reader and tell you how it landed.',
    needs: ['book'],
    label: 'Read it',
    action: {
      kind: 'task',
      title: 'First-reader notes: {book}',
      detail: order(
        'Read the most recent chapter of {book} the way a thoughtful first reader would, and write notes for the author.',
        SOURCES,
        'Cover: what you understood to be happening, where you were most pulled in, where your attention slipped, anything that confused you, what you expect to happen next, and three lines you liked (quoted). Be honest and kind. Do not rewrite the chapter.',
        FINISH,
      ),
    },
  },
  {
    id: 'interview-character',
    category: 'Story',
    title: 'Interview one of your characters',
    blurb: 'We can interview a character from {book} so you hear how they talk and what they want.',
    needs: [],
    label: 'Start',
    action: {
      kind: 'say',
      say: 'I want to interview one of the characters from {book}. Ask me which one, then answer my questions in their voice.',
    },
  },

  // ── Research ──
  {
    id: 'comp-titles',
    category: 'Research',
    title: 'Find comparable titles',
    blurb: 'I can find eight recent books comparable to {book} and say why each one fits.',
    needs: ['browser'],
    label: 'Find them',
    action: {
      kind: 'task',
      title: 'Comparable titles for {book}',
      detail: order(
        'Find eight comparable titles for {book}.',
        SOURCES,
        BROWSE,
        'Choose books published in the last five years, in the same genre and for the same readers. For each one give: title, author, year, publisher if you can find it, one line on what it is about, and two or three lines on why it is comparable (tone, premise, audience or structure). Finish with the two you would name in a pitch and why.',
        FINISH,
      ),
    },
  },
  {
    id: 'setting-research',
    category: 'Research',
    title: 'Research your setting',
    blurb: 'I can research the real places and period behind {book} and bring back details you can use.',
    needs: ['browser', 'book'],
    label: 'Research it',
    action: {
      kind: 'task',
      title: 'Setting research: {book}',
      detail: order(
        'Research the setting of {book}.',
        SOURCES,
        BROWSE,
        'First work out from the material where and when the story takes place. Then gather concrete, usable details: what the place looks, sounds and smells like, weather and seasons, food, clothing, work, transport, money, how people speak, and a few small facts a local would know. Group them under headings and keep each detail to one or two lines with its source.',
        FINISH,
      ),
    },
  },
  {
    id: 'fact-check-chapter',
    category: 'Research',
    title: 'Fact-check a chapter',
    blurb: 'I can fact-check the latest chapter of {book} and flag anything that looks wrong, with sources.',
    needs: ['browser'],
    label: 'Check it',
    action: {
      kind: 'task',
      title: 'Fact check: latest chapter of {book}',
      detail: order(
        'Fact-check the most recent chapter of {book}.',
        SOURCES,
        BROWSE,
        'List every checkable claim about the real world: dates, historical events, science, medicine, law, geography, travel times, prices, technology and how jobs are done. For each, give a verdict (correct, wrong, or could not confirm), what the sources say, and a suggested correction where one is needed. Leave invented story facts alone.',
        FINISH,
      ),
    },
  },
  {
    id: 'name-ideas',
    category: 'Research',
    title: 'Suggest character and place names',
    blurb: 'I can suggest names for characters and places that suit the world and period of {book}.',
    needs: [],
    label: 'Suggest some',
    action: {
      kind: 'task',
      title: 'Name ideas for {book}',
      detail: order(
        'Suggest names for {book}.',
        SOURCES,
        'Give twenty names for people (a mix of first names and surnames) and ten for places, all fitting the time, region and tone of the story. For each, add a few words on its origin or feel. Avoid names that start with the same letter as, or sound like, names already in the book, and list the existing names you steered around. If you have a browser, use it to check that period names are right for the period.',
        FINISH,
      ),
    },
  },
  {
    id: 'genre-expectations',
    category: 'Research',
    title: 'Map what readers of the genre expect',
    blurb: 'I can list what readers of your genre expect and where {book} meets or bends each one.',
    needs: [],
    label: 'Map it',
    action: {
      kind: 'task',
      title: 'Genre expectations for {book}',
      detail: order(
        'Map reader expectations for the genre of {book}.',
        SOURCES,
        'Name the genre and subgenre you think it belongs to and why. Then list the ten or so things readers of that genre expect (typical length, must-have scenes, kind of ending, tone, heat or violence level, common tropes). For each, say whether the book meets it, bends it on purpose, or has not got there yet. If you have a browser, use it to confirm current norms and cite the page titles and addresses you used.',
        FINISH,
      ),
    },
  },

  // ── Marketing ──
  {
    id: 'back-cover-blurb',
    category: 'Marketing',
    title: 'Draft the back cover blurb',
    blurb: 'I can draft three versions of the back cover blurb for {book} in different tones.',
    needs: ['book'],
    label: 'Draft it',
    action: {
      kind: 'task',
      title: 'Back cover blurb: {book}',
      detail: order(
        'Draft the back cover blurb for {book}.',
        SOURCES,
        'Write three versions of 120 to 180 words each: one that leads with the character, one that leads with the premise, and one that leads with mood and voice. Each needs a hook in the first line, the stakes, and no spoilers past the midpoint. Add a one line tagline for each, then say which version you would use and why.',
        FINISH,
      ),
    },
  },
  {
    id: 'newsletter-draft',
    category: 'Marketing',
    title: 'Draft a reader newsletter',
    blurb: 'I can draft a friendly newsletter to your readers about how {book} is coming along.',
    needs: [],
    label: 'Draft it',
    action: {
      kind: 'task',
      title: 'Reader newsletter draft',
      detail: order(
        'Draft a newsletter from the author to their readers about how {book} is coming along.',
        SOURCES,
        'Write 250 to 400 words in the author\'s own voice: a personal opening, one real update on the book, one small behind-the-scenes detail from the writing, and a friendly sign-off with a single ask (reply, share or pre-order, whichever fits). Offer three subject lines. Do not promise dates the material does not support.',
        'When Google is connected, finish by saving the newsletter as a Gmail draft with no recipients filled in. Saving the draft will ask the author for approval, which is expected. Say in the document whether the draft was saved.',
        FINISH,
      ),
    },
  },
  {
    id: 'social-week',
    category: 'Marketing',
    title: 'Write a week of social posts',
    blurb: 'I can write seven short social posts about {book}, one for each day of the week.',
    needs: [],
    label: 'Write them',
    action: {
      kind: 'task',
      title: 'A week of social posts',
      detail: order(
        'Write seven social posts about {book}, one for each day from Monday to Sunday.',
        SOURCES,
        'Vary them: a line from the book, a writing-day moment, a question for readers, a character introduction, a behind-the-scenes fact, a progress update and a thank-you. Keep each under 280 characters so it works anywhere, in the author\'s voice, with at most two hashtags. For each, add one line suggesting a picture to go with it. Do not post anything.',
        FINISH,
      ),
    },
  },
  {
    id: 'query-letter',
    category: 'Marketing',
    title: 'Draft a query letter',
    blurb: 'I can draft a query letter for {book} with a hook, a short pitch and a bio paragraph.',
    needs: ['book'],
    label: 'Draft it',
    action: {
      kind: 'task',
      title: 'Query letter: {book}',
      detail: order(
        'Draft a query letter to literary agents for {book}.',
        SOURCES,
        'One page: a one or two sentence hook, a pitch paragraph of about 150 words (character, what they want, what stands in the way, what is at stake), a housekeeping line (title, genre, word count, two comparable titles) and a short bio paragraph. Leave clearly marked blanks such as [word count] for facts you do not have. Do not send it to anyone.',
        FINISH,
      ),
    },
  },
  {
    id: 'launch-checklist',
    category: 'Marketing',
    title: 'Make a launch checklist',
    blurb: 'I can build a week by week launch checklist for {book}, from eight weeks out to launch day.',
    needs: [],
    label: 'Make it',
    action: {
      kind: 'task',
      title: 'Launch checklist for {book}',
      detail: order(
        'Build a launch checklist for {book}.',
        SOURCES,
        'Lay it out week by week, from eight weeks before launch to two weeks after, as Markdown checkboxes. Cover: final files and proof, cover and blurb, store page and categories, advance readers and reviews, newsletter and social posts, launch day itself, and follow-up. Keep each item small enough to do in one sitting and mark the five that matter most.',
        FINISH,
      ),
    },
  },
  {
    id: 'reader-persona',
    category: 'Marketing',
    title: 'Sketch your ideal reader',
    blurb: 'I can sketch the reader most likely to love {book} and where to find them.',
    needs: [],
    label: 'Sketch them',
    action: {
      kind: 'task',
      title: 'Ideal reader for {book}',
      detail: order(
        'Sketch the ideal reader for {book}.',
        SOURCES,
        'Describe one specific person: who they are, what else they read and watch, what they want from a book like this, what would make them put it down, where they hear about books, and the words they would use to recommend it to a friend. Then list five places or communities where readers like this gather, and three things the author could do this month to reach them. If you have a browser, use it and cite the page titles and addresses you used.',
        FINISH,
      ),
    },
  },

  // ── Routine ──
  {
    id: 'morning-recap',
    category: 'Routine',
    title: 'A morning recap at 7:30',
    blurb: 'I can leave a note each morning with where you left off and one question to get you writing.',
    needs: [],
    label: 'Set it up',
    action: {
      kind: 'schedule',
      title: 'Morning recap',
      cron: '30 7 * * *',
      detail: order(
        'Write this morning\'s recap for the author of {book}.',
        'In under 150 words: where they left off (the last scene or chapter they worked on and how it ended), and then one specific question about what happens next, to get them writing.',
        SHORT_FINISH,
      ),
    },
  },
  {
    id: 'weekly-review',
    category: 'Routine',
    title: 'A weekly review on Fridays',
    blurb: 'I can sum up your writing week every Friday afternoon and suggest a focus for the next one.',
    needs: [],
    label: 'Set it up',
    action: {
      kind: 'schedule',
      title: 'Weekly review',
      cron: '0 17 * * 5',
      detail: order(
        'Write the weekly review for the author of {book}.',
        'In under 250 words: what got done this week (words written, chapters touched, tasks finished), one thing that went well, anything still waiting for their review, and one suggested focus for next week. Be kind about quiet weeks and never scold.',
        SHORT_FINISH,
      ),
    },
  },
  {
    id: 'streak-nudge',
    category: 'Routine',
    title: 'A gentle evening nudge',
    blurb: 'I can send a short encouragement and one tiny next step each evening at 8.',
    needs: [],
    label: 'Set it up',
    action: {
      kind: 'schedule',
      title: 'Evening nudge',
      cron: '0 20 * * *',
      detail: order(
        'Write tonight\'s nudge for the author of {book}.',
        'Only a short encouragement plus one tiny next step. Two sentences at most: one warm line, then one step that takes ten minutes or less, such as writing a single line of dialogue. No guilt, no statistics, no mention of missed days.',
        SHORT_FINISH,
      ),
    },
  },
  {
    id: 'read-last-scene',
    category: 'Routine',
    title: 'Hear your last scene read aloud',
    blurb: 'I can read your last scene aloud so you can hear how it flows.',
    needs: [],
    label: 'Read it to me',
    action: { kind: 'say', say: 'Read me the last scene aloud.' },
  },

  // ── Email and calendar ──
  {
    id: 'inbox-triage',
    category: 'Email and calendar',
    title: 'Sort your author inbox',
    blurb: 'I can sum up unread author mail from the last three days and draft replies for you to approve.',
    needs: ['google'],
    label: 'Sort it',
    action: {
      kind: 'task',
      title: 'Inbox triage',
      detail: order(
        'Triage the author\'s inbox.',
        'Use your Gmail tools to find unread mail from the last 3 days that relates to their writing life: editors, agents, publishers, readers, reviewers, events, contracts and payments. Skip promotions and anything personal.',
        'Report a table: From, Subject, What they want (one line), Needs a reply (yes or no), Deadline if any. Then, for each message that needs a reply, write a short proposed reply in the author\'s voice and save it as a Gmail draft. Saving each draft will ask the author for approval, which is expected. Never send anything. Say which drafts were saved.',
        FINISH,
      ),
    },
  },
  {
    id: 'writing-time-this-week',
    category: 'Email and calendar',
    title: 'Find writing time this week',
    blurb: 'I can look through your calendar for free blocks and propose three writing sessions this week.',
    needs: ['google'],
    label: 'Find time',
    action: {
      kind: 'task',
      title: 'Writing time this week',
      detail: order(
        'Find writing time for the author this week, for {book}.',
        'Use your Google Calendar tools to read the next seven days. Find free blocks of at least 45 minutes between 7am and 9pm, leaving 15 minutes clear on either side of existing events.',
        'Propose three writing sessions: the day, start and end time, why that slot looks good, and one small goal for the session. List two backup slots. Do not create calendar events unless the author asks. If you do propose creating them, that will need their approval.',
        FINISH,
      ),
    },
  },
  {
    id: 'follow-ups',
    category: 'Email and calendar',
    title: 'Chase emails waiting on a reply',
    blurb: 'I can list emails that have waited more than five days for a reply and draft gentle follow-ups.',
    needs: ['google'],
    label: 'Find them',
    action: {
      kind: 'task',
      title: 'Email follow-ups',
      detail: order(
        'Find the author\'s emails that are still waiting on a reply.',
        'Use your Gmail tools to look through sent mail from the last 30 days about their writing life (editors, agents, publishers, reviewers, events). Keep the ones where the author asked for something and nobody has answered for more than 5 days.',
        'Report a table: To, Subject, Sent on, Days waiting, What was asked. For each, write a short, polite follow-up in the author\'s voice and save it as a Gmail draft on the same thread. Saving each draft will ask the author for approval, which is expected. Never send anything. Say which drafts were saved.',
        FINISH,
      ),
    },
  },
  {
    id: 'drive-tidy-map',
    category: 'Email and calendar',
    title: 'Map your manuscript files in Drive',
    blurb: 'I can list where the drafts and notes for {book} live in your Drive and which copy is newest.',
    needs: ['google'],
    label: 'Map them',
    action: {
      kind: 'task',
      title: 'Drive map for {book}',
      detail: order(
        'Map the files for {book} in the author\'s Google Drive.',
        DRIVE_FIRST,
        'Report a table of every file that looks like part of the book: name, type, folder, last changed, and what it seems to be (current draft, old draft, notes, outline, research). Point out likely duplicates and say which copy is the newest. Do not move, rename or delete anything.',
        FINISH,
      ),
    },
  },
];

// ── Functions ──

/** A play is available when everything it needs is present. Reports the first missing need. */
export function availability(play: Play, ctx: PlayContext): { available: boolean; missing?: PlayNeed } {
  for (const need of play.needs) {
    const have = need === 'book' ? !!ctx.bookTitle?.trim() : need === 'google' ? ctx.hasGoogle === true : ctx.hasBrowser === true;
    if (!have) return { available: false, missing: need };
  }
  return { available: true };
}

const fill = (text: string, book: string): string => text.split('{book}').join(book);

/** The play with `{book}` filled in everywhere. Never mutates the original. */
export function renderPlay(play: Play, ctx: PlayContext): Play {
  const title = ctx.bookTitle?.replace(/\s+/g, ' ').trim() || '';
  const shown = title || 'your book';
  const said = title || 'my book';
  const briefed = title ? `"${title}"` : 'their current book';
  const chapter = Number.isFinite(ctx.chapter) && Number(ctx.chapter) > 0
    ? `\n\nThe author is currently on chapter ${Math.floor(Number(ctx.chapter))}.` : '';
  const a = play.action;
  const action: PlayAction = a.kind === 'task'
    ? { kind: 'task', title: fill(a.title, shown), detail: fill(a.detail, briefed) + chapter }
    : a.kind === 'schedule'
      ? { kind: 'schedule', title: fill(a.title, shown), detail: fill(a.detail, briefed), cron: a.cron }
      : { kind: 'say', say: fill(a.say, said) };
  return {
    id: play.id,
    category: play.category,
    title: fill(play.title, shown),
    blurb: fill(play.blurb, shown),
    needs: [...play.needs],
    label: fill(play.label, shown),
    action,
  };
}

/**
 * Choose one available play that is not excluded. Categories take turns as the
 * seed counts up, so two picks in a row come from different categories whenever
 * more than one category has something to offer. `avoidCategory` (the category
 * of the previous suggestion) keeps that true when the pool changes between
 * picks. The same input always gives the same play.
 */
export function pickPlay(
  plays: Play[],
  ctx: PlayContext,
  opts: { excludeIds: Set<string>; seed: number; avoidCategory?: PlayCategory },
): Play | null {
  const pool = plays.filter(p => !opts.excludeIds.has(p.id) && availability(p, ctx).available);
  if (pool.length === 0) return null;
  const cats = PLAY_CATEGORIES.filter(c => pool.some(p => p.category === c));
  const seed = Number.isFinite(opts.seed) ? Math.abs(Math.floor(opts.seed)) : 0;
  let turn = seed % cats.length;
  // The seed's own turn wins; step to the next category only to avoid a repeat.
  if (cats.length > 1 && cats[turn] === opts.avoidCategory) turn = (turn + 1) % cats.length;
  const inCat = pool.filter(p => p.category === cats[turn]);
  return inCat[Math.floor(seed / cats.length) % inCat.length];
}
