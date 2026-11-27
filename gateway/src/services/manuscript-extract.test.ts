import { describe, it, expect } from 'vitest';
import AdmZip from 'adm-zip';
import {
  extractDocx, extractParas, parseDocumentXml, textToParas, decodeText, rtfToText, isChapterLine,
  buildChapters, splitFileIntoChapters, chapterFileOrder, compareChapterFiles, countWords, chapterNumberOfTitle,
  UnreadableFileError, type ExtractedFile, type Para,
} from './manuscript-extract.js';

// ── Fixtures: real, minimal .docx files built in the test ──

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const para = (text: string, style?: string): string =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

export function makeDocx(body: string): Buffer {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'));
  zip.addFile('word/document.xml', Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`));
  return zip.toBuffer();
}

const prose = (words: number, seed = 'marsh'): string => Array.from({ length: words }, (_, i) => `${seed}${i}`).join(' ');
const file = (rel: string, paras: Para[], modifiedAt = '2026-01-01T00:00:00.000Z'): ExtractedFile =>
  ({ rel, paras, words: paras.reduce((n, p) => n + countWords(p.t), 0), modifiedAt });
const body = (words: number, seed?: string): Para => ({ t: prose(words, seed) });

describe('docx extraction', () => {
  it('reads paragraphs and heading styles', () => {
    const buf = makeDocx(
      para('The Lantern Marsh', 'Title') +
      para('Chapter One', 'Heading1') +
      para('Mara Venn rowed out at dawn &amp; did not look back.') +
      para('A quieter scene', 'Heading2') +
      para('Tobin waited on the jetty.') +
      '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>Chapter Two</w:t></w:r></w:p>' +
      para('   ') +
      '<w:p/>',
    );
    expect(extractDocx(buf)).toEqual([
      { t: 'The Lantern Marsh', h: 0 },
      { t: 'Chapter One', h: 1 },
      { t: 'Mara Venn rowed out at dawn & did not look back.' },
      { t: 'A quieter scene', h: 2 },
      { t: 'Tobin waited on the jetty.' },
      { t: 'Chapter Two', h: 1 },
    ]);
    expect(extractParas('Book.DOCX', buf)).toHaveLength(6);
  });

  it('ignores tracked deletions, moved-away text, comments, footnote references and images', () => {
    const buf = makeDocx(
      '<w:p>' +
      '<w:r><w:t xml:space="preserve">She had </w:t></w:r>' +
      '<w:del w:id="1" w:author="Editor"><w:r><w:delText>green</w:delText></w:r></w:del>' +
      '<w:del w:id="2" w:author="Editor"><w:r><w:t>emerald</w:t></w:r></w:del>' +
      '<w:moveFrom w:id="3"><w:r><w:t>moved away</w:t></w:r></w:moveFrom>' +
      '<w:ins w:id="4" w:author="Editor"><w:r><w:t>grey</w:t></w:r></w:ins>' +
      '<w:commentRangeStart w:id="5"/><w:r><w:t xml:space="preserve"> eyes</w:t></w:r><w:commentRangeEnd w:id="5"/>' +
      '<w:r><w:commentReference w:id="5"/></w:r>' +
      '<w:r><w:footnoteReference w:id="2"/></w:r>' +
      '<w:r><w:drawing><wp:inline><a:graphic><wps:txbx><w:txbxContent><w:p><w:r><w:t>caption in a picture</w:t></w:r></w:p></w:txbxContent></wps:txbx></a:graphic></wp:inline></w:drawing></w:r>' +
      '<w:r><w:instrText>PAGE</w:instrText></w:r>' +
      '<w:r><w:t>.</w:t></w:r>' +
      '</w:p>',
    );
    expect(extractDocx(buf)).toEqual([{ t: 'She had grey eyes.' }]);
  });

  it('keeps tabs and line breaks, and does not mistake tab stops for tabs', () => {
    const buf = makeDocx(
      '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>' +
      '<w:r><w:t>one</w:t><w:tab/><w:t>two</w:t><w:br/><w:t>three</w:t><w:noBreakHyphen/><w:t>four</w:t></w:r></w:p>',
    );
    expect(extractDocx(buf)).toEqual([{ t: 'one\ttwo\nthree-four' }]);
  });

  it('refuses a malformed zip, a zip that is not a Word file, and an encrypted-looking file, without crashing', () => {
    expect(() => extractDocx(Buffer.from('this is not a zip file at all'))).toThrow(UnreadableFileError);
    expect(() => extractDocx(Buffer.alloc(0))).toThrow(UnreadableFileError);
    const notWord = new AdmZip();
    notWord.addFile('hello.txt', Buffer.from('hi'));
    expect(() => extractDocx(notWord.toBuffer())).toThrow(/not a Word document/);
    // Password-protected Office files are OLE containers, not zips.
    expect(() => extractDocx(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]))).toThrow(UnreadableFileError);
    const truncated = makeDocx(para('Some text here'));
    expect(() => extractDocx(truncated.subarray(0, truncated.length - 30))).toThrow(UnreadableFileError);
  });

  it('refuses an oversized document.xml, also when the zip header lies about its size', () => {
    const big = makeDocx(para('x'.repeat(200_000)));
    expect(big.length).toBeLessThan(20_000); // compresses well: a small file hiding a large one
    expect(() => extractDocx(big, 50_000)).toThrow(/too large/);
    expect(extractDocx(big, 1_000_000)).toHaveLength(1);

    // Rewrite the declared uncompressed size (central directory and local header) to a small number.
    const lying = Buffer.from(big);
    const name = Buffer.from('word/document.xml');
    for (let i = 0; i + 46 < lying.length; i++) {
      const central = lying.readUInt32LE(i) === 0x02014b50 && lying.subarray(i + 46, i + 46 + name.length).equals(name);
      const local = lying.readUInt32LE(i) === 0x04034b50 && lying.subarray(i + 30, i + 30 + name.length).equals(name);
      if (central) lying.writeUInt32LE(100, i + 24);
      if (local) lying.writeUInt32LE(100, i + 22);
    }
    expect(() => extractDocx(lying, 50_000)).toThrow(UnreadableFileError);
  });

  it('survives nested paragraphs and unknown markup', () => {
    const xml = '<w:body><w:p><w:r><w:t>outer</w:t></w:r><w:p><w:r><w:t>inner</w:t></w:r></w:p><w:r><w:t>tail</w:t></w:r></w:p><!-- note --><w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body>';
    expect(parseDocumentXml(xml)).toEqual([{ t: 'outerinner\ntail' }, { t: 'cell' }]);
  });
});

describe('text, Markdown and RTF', () => {
  it('Markdown: headings get levels, front matter is dropped, blank lines split paragraphs', () => {
    const md = '---\ntitle: The Lantern Marsh\n---\n# Chapter One\n\nMara rowed out\nat dawn.\n\n## A quieter scene ##\nTobin waited.\n';
    expect(textToParas(md, true)).toEqual([
      { t: 'Chapter One', h: 1 },
      { t: 'Mara rowed out\nat dawn.' },
      { t: 'A quieter scene', h: 2 },
      { t: 'Tobin waited.' },
    ]);
  });

  it('plain text: a chapter line is its own paragraph even without blank lines', () => {
    expect(textToParas('CHAPTER 1\nMara rowed out.\nShe did not look back.\n\n2\nTobin waited.', false)).toEqual([
      { t: 'CHAPTER 1' }, { t: 'Mara rowed out.\nShe did not look back.' }, { t: '2' }, { t: 'Tobin waited.' },
    ]);
  });

  it('recognises chapter lines and leaves ordinary sentences alone', () => {
    for (const yes of ['Chapter 1', 'CHAPTER TWELVE', 'Chapter Twenty-One: The Storm', 'chapter iv', 'Part Two', 'PART 3 - The Marsh',
      'Prologue', 'Epilogue', 'Interlude: Tobin', '7', '12.', '**Chapter 3**', '## Chapter 9']) {
      expect(isChapterLine(yes), yes).toBe(true);
    }
    for (const no of ['Part of him wanted to leave.', 'Chapter and verse, he knew it by heart.', 'The prologue was dull.',
      'Epilogue was the word she used, and it stung.', '1999 was a hard year', '12345', 'Partly cloudy', '', 'Chapters end.']) {
      expect(isChapterLine(no), no).toBe(false);
    }
  });

  it('decodes UTF-8 with a BOM, UTF-16 and Windows-1252', () => {
    expect(decodeText(Buffer.from('﻿café', 'utf8'))).toBe('café');
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('café', 'utf16le')]))).toBe('café');
    const be = Buffer.from('café', 'utf16le');
    be.swap16();
    expect(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe('café');
    expect(decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x68, 0x69, 0x94]))).toBe('café “hi”');
  });

  it('RTF: plain text comes out, tables of fonts and pictures do not', () => {
    const rtf = String.raw`{\rtf1\ansi\deff0{\fonttbl{\f0 Times New Roman;}}{\colortbl;\red0\green0\blue0;}{\*\generator Riched20;}{\info{\title Secret}}` +
      String.raw`\pard Chapter 1\par Mara said \ldblquote caf\'e9\rdblquote  to Tobin` + '\\u8212?and left.' + String.raw`\par {\pict\wmetafile8 0102030405}\tab Indented \{braces\}\line next line\par}`;
    const text = rtfToText(Buffer.from(rtf, 'latin1'));
    expect(text).not.toMatch(/Times New Roman|Riched20|Secret|0102030405/);
    expect(extractParas('draft.rtf', Buffer.from(rtf, 'latin1'))).toEqual([
      { t: 'Chapter 1' },
      { t: 'Mara said “café” to Tobin—and left.' },
      { t: 'Indented {braces}\nnext line' },
    ]);
    expect(() => rtfToText(Buffer.from('plain text'))).toThrow(UnreadableFileError);
    expect(() => extractParas('book.pages', Buffer.from('x'))).toThrow(UnreadableFileError);
  });
});

describe('chapter order from file names', () => {
  it('reads the chapter number from the name', () => {
    expect(chapterFileOrder('ch2.md')).toBe(2);
    expect(chapterFileOrder('ch10.md')).toBe(10);
    expect(chapterFileOrder('Chapter 12 - The Storm.docx')).toBe(12);
    expect(chapterFileOrder('ch-03.txt')).toBe(3);
    expect(chapterFileOrder('03 The Jetty.docx')).toBe(3);
    expect(chapterFileOrder('drafts/chapter_7.md')).toBe(7);
    expect(chapterFileOrder('Lantern Marsh ch04.docx')).toBe(4);
    expect(chapterFileOrder('Prologue.docx')).toBe(-1);
    expect(chapterFileOrder('epilogue.md')).toBe(1_000_000);
    for (const no of ['notes.md', 'characters.docx', 'sketch 12.md', '2024-plan.md', 'outline.txt']) expect(chapterFileOrder(no), no).toBeNull();
  });

  it('reads the chapter number a title states', () => {
    expect(chapterNumberOfTitle('Chapter 7')).toBe(7);
    expect(chapterNumberOfTitle('7. The Storm')).toBe(7);
    expect(chapterNumberOfTitle('Chapter Ten')).toBe(10);
    expect(chapterNumberOfTitle('CHAPTER TWENTY-ONE: Dusk')).toBe(21);
    expect(chapterNumberOfTitle('Chapter Thirty Two')).toBe(32);
    expect(chapterNumberOfTitle('Chapter Seven: Two Boats')).toBe(7);
    expect(chapterNumberOfTitle('The Storm')).toBeNull();
    expect(chapterNumberOfTitle('Prologue')).toBeNull();
  });

  it('sorts naturally: ch2 before ch10, prologue first, epilogue last', () => {
    const names = ['ch10.md', 'epilogue.md', 'ch2.md', 'ch1.md', 'prologue.md', 'ch11.md', 'ch3.md'];
    expect([...names].sort(compareChapterFiles)).toEqual(['prologue.md', 'ch1.md', 'ch2.md', 'ch3.md', 'ch10.md', 'ch11.md', 'epilogue.md']);
  });
});

describe('chapter splitting', () => {
  it('a. many chapter files: one chapter per file in natural order, the rest are notes', () => {
    const files = [
      file('ch10.md', [{ t: 'Chapter Ten', h: 1 }, body(30)]),
      file('ch2.md', [body(20)]),
      file('ch1.md', [{ t: 'Chapter 1' }, { t: 'The Jetty', h: 2 }, body(25), body(5)]),
      file('characters.md', [{ t: 'Cast', h: 1 }, body(40, 'note')]),
      file('empty.md', []),
    ];
    const out = buildChapters(files);
    expect(out.map(c => [c.kind, c.file, c.title, c.words])).toEqual([
      ['chapter', 'ch1.md', 'Chapter 1: The Jetty', 30],
      ['chapter', 'ch2.md', 'ch2', 20],
      ['chapter', 'ch10.md', 'Chapter Ten', 30],
      ['notes', 'characters.md', 'Cast', 40],
    ]);
    expect(out[0].text.startsWith('marsh0 ')).toBe(true);
    expect(out[0].text).not.toContain('The Jetty');
  });

  it('b. one manuscript file with styled headings: split there; the title page is front matter', () => {
    const f = file('The Lantern Marsh.docx', [
      { t: 'The Lantern Marsh', h: 0 },
      { t: 'for the ferrymen' }, body(40, 'foreword'),
      { t: 'Chapter One', h: 1 }, body(50), { t: 'a scene break heading', h: 2 }, body(10),
      { t: 'Chapter Two', h: 1 }, body(60),
      { t: 'Chapter Three', h: 1 },
    ]);
    const out = splitFileIntoChapters(f);
    expect(out.map(c => [c.kind, c.ordinal, c.title, c.words])).toEqual([
      ['chapter', 0, 'Chapter One', 64],
      ['chapter', 1, 'Chapter Two', 60],
      ['notes', -1, 'Front matter', 46],
    ]);
    expect(out[0].text).toContain('a scene break heading');
    // A bare title page is not worth a notes entry.
    const short = splitFileIntoChapters(file('b.docx', [{ t: 'The Lantern Marsh', h: 0 }, { t: 'Chapter One', h: 1 }, body(5), { t: 'Chapter Two', h: 1 }, body(5)]));
    expect(short.map(c => c.kind)).toEqual(['chapter', 'chapter']);
  });

  it('b. plain text with chapter lines and bare numbers: split at each', () => {
    const paras = textToParas(`Prologue\n\n${prose(10)}\n\nChapter 1\n\n${prose(20)}\n\n2.\n\n${prose(30)}\n\nPART TWO\n\nChapter 3: The Storm\n\n${prose(5)}`, false);
    const out = splitFileIntoChapters(file('book.txt', paras));
    expect(out.map(c => [c.title, c.words])).toEqual([['Prologue', 10], ['Chapter 1', 20], ['Chapter 2', 30], ['Chapter 3: The Storm', 5]]);
    expect(out.every(c => c.kind === 'chapter')).toBe(true);
  });

  it('b. parts as Heading 1 and chapters as Heading 2: chapters still split, empty part dividers are dropped', () => {
    const f = file('book.docx', [
      { t: 'Part One', h: 1 }, { t: 'Chapter 1', h: 2 }, body(10), { t: 'Chapter 2', h: 2 }, body(11),
      { t: 'Part Two', h: 1 }, { t: 'Chapter 3', h: 2 }, body(12),
    ]);
    expect(splitFileIntoChapters(f).map(c => [c.title, c.words])).toEqual([['Chapter 1', 10], ['Chapter 2', 11], ['Chapter 3', 12]]);
  });

  it('c. a file with no chapter headings is one chapter, titled from its heading or its name', () => {
    expect(splitFileIntoChapters(file('drafts/The_Long_Night.md', [body(40), body(2)])).map(c => [c.title, c.words, c.ordinal]))
      .toEqual([['The Long Night', 42, 0]]);
    expect(splitFileIntoChapters(file('story.md', [{ t: 'A Ferry at Dusk', h: 1 }, body(12)])).map(c => [c.title, c.words]))
      .toEqual([['A Ferry at Dusk', 12]]);
    expect(buildChapters([file('blank.md', [])])).toEqual([]);
  });

  it('notes detection: one big manuscript plus loose notes files', () => {
    const out = buildChapters([
      file('ideas.md', [body(30, 'idea')]),
      file('The Lantern Marsh.docx', [{ t: 'Chapter 1', h: 1 }, body(300), { t: 'Chapter 2', h: 1 }, body(200)]),
      file('research/boats.txt', [body(50, 'boat')]),
    ]);
    expect(out.map(c => [c.kind, c.file, c.title, c.words])).toEqual([
      ['chapter', 'The Lantern Marsh.docx', 'Chapter 1', 300],
      ['chapter', 'The Lantern Marsh.docx', 'Chapter 2', 200],
      ['notes', 'ideas.md', 'ideas', 30],
      ['notes', 'research/boats.txt', 'boats', 50],
    ]);
  });

  it('a full manuscript beside a couple of numbered scraps wins over the scraps', () => {
    const out = buildChapters([
      file('Full draft.docx', [{ t: 'Chapter 1', h: 1 }, body(500), { t: 'Chapter 2', h: 1 }, body(400), { t: 'Chapter 3', h: 1 }, body(300)]),
      file('ch1 notes.md', [body(20)]),
      file('ch2 notes.md', [body(20)]),
    ]);
    expect(out.filter(c => c.kind === 'chapter').map(c => c.file)).toEqual(['Full draft.docx', 'Full draft.docx', 'Full draft.docx']);
    expect(out.filter(c => c.kind === 'notes')).toHaveLength(2);
    // A big notes file beside real chapter files does not take over.
    const early = buildChapters([file('ch1.md', [body(50)]), file('ch2.md', [body(60)]), file('worldbuilding.md', [body(900, 'lore')])]);
    expect(early.map(c => [c.kind, c.file])).toEqual([['chapter', 'ch1.md'], ['chapter', 'ch2.md'], ['notes', 'worldbuilding.md']]);
  });

  it('several unnumbered files of similar size are chapters in name order', () => {
    const out = buildChapters([
      file('The Storm.md', [body(100)]), file('Arrival.md', [body(110)]), file('The Jetty.md', [body(90)]), file('Dusk.md', [body(105)]),
    ]);
    expect(out.map(c => [c.kind, c.title])).toEqual([['chapter', 'Arrival'], ['chapter', 'Dusk'], ['chapter', 'The Jetty'], ['chapter', 'The Storm']]);
  });
});
