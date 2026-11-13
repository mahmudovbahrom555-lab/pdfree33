const pptxType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const presentationNs = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const drawingNs = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const relationshipNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const endShow = 'ppaction://hlinkshowjump?jump=endshow';

export function answerOptions(count) {
  return count === 5 ? 'ABCDE' : 'ABCD';
}

function button(slide, label, target, x, y, w) {
  slide.addText(label, {
    x, y, w, h: 0.55, margin: 0, align: 'center', valign: 'mid',
    fontSize: 20, bold: true, color: 'FFFFFF', fill: { color: target === endShow ? '344054' : '166447' },
    hyperlink: typeof target === 'number' ? { slide: target } : { url: target },
  });
}

function exitButton(slide, endSlide) {
  button(slide, 'Exit', endSlide, 10.05, 6.65, 2.95);
}

async function finalizeQuiz(deck, zipApi, endSlide, slideCount) {
  const zip = await zipApi.loadAsync(await deck.write({ outputType: 'arraybuffer' }));
  const path = 'ppt/presProps.xml';
  const xml = new DOMParser().parseFromString(await zip.file(path).async('string'), 'application/xml');
  const root = xml.documentElement;
  const show = xml.createElementNS(presentationNs, 'p:showPr');
  show.setAttribute('useTimings', '0');
  show.append(xml.createElementNS(presentationNs, 'p:present'));
  const existing = root.getElementsByTagNameNS(presentationNs, 'showPr')[0];
  if (existing) existing.replaceWith(show);
  else root.prepend(show);
  zip.file(path, new XMLSerializer().serializeToString(xml));
  // PptxGenJS writes URL links as external relationships. End Show is a
  // presentation action and uses an empty relationship ID instead.
  const parser = new DOMParser();
  const serializer = new XMLSerializer();
  for (let index = 1; index <= slideCount; index++) {
    const slidePath = `ppt/slides/slide${index}.xml`;
    const relsPath = `ppt/slides/_rels/slide${index}.xml.rels`;
    const slide = parser.parseFromString(await zip.file(slidePath).async('string'), 'application/xml');
    const rels = parser.parseFromString(await zip.file(relsPath).async('string'), 'application/xml');
    const root = slide.documentElement;
    const transition = slide.createElementNS(presentationNs, 'p:transition');
    transition.setAttribute('advClick', '0');
    const following = [...root.children].find(child => ['timing', 'extLst'].includes(child.localName));
    root.insertBefore(transition, following ?? null);

    if (index === endSlide) {
      const exitLinks = [...rels.documentElement.children].filter(rel => rel.getAttribute('Target') === endShow);
      const exitIds = new Set(exitLinks.map(rel => rel.getAttribute('Id')));
      let exitConfigured = false;
      for (const link of [...slide.getElementsByTagNameNS(drawingNs, 'hlinkClick')]) {
        if (!exitIds.has(link.getAttributeNS(relationshipNs, 'id'))) continue;
        if (link.parentNode.localName !== 'cNvPr') {
          link.remove();
          continue;
        }
        link.setAttributeNS(relationshipNs, 'r:id', '');
        link.setAttribute('action', endShow);
        exitConfigured = true;
      }
      if (!exitConfigured) throw new Error(`Couldn't add the exit from the show to slide ${index}.`);
      for (const rel of exitLinks) rel.remove();
      zip.file(relsPath, serializer.serializeToString(rels));
    }
    zip.file(slidePath, serializer.serializeToString(slide));
  }
  return zip.generateAsync({ type: 'blob', mimeType: pptxType, compression: 'DEFLATE' });
}

export async function makeQuizFile(deck, tasks, render, zipApi) {
  const endSlide = tasks.length + 1;
  const feedback = [];

  for (const [index, task] of tasks.entries()) {
    const start = index + 1;
    const next = start + 1;
    const question = deck.addSlide();
    const canvas = await render(task);
    question.addImage({ data: canvas.toDataURL(), x: 0, y: 0, w: 40 / 3, h: 7.5 });
    exitButton(question, endSlide);

    if (!task.quiz) {
      button(question, 'Next →', next, 0.34, 6.65, 2.3);
      continue;
    }
    const correctSlide = endSlide + feedback.length * 2 + 1;
    for (const [i, answer] of [...answerOptions(task.quiz.count)].entries()) {
      button(question, answer, answer === task.quiz.correct ? correctSlide : correctSlide + 1,
        0.34 + i * 1.35, 6.65, 1.15);
    }
    feedback.push({ task, start, next });
  }

  const end = deck.addSlide();
  end.addText('Quiz finished', { x: 0.65, y: 0.8, w: 12, h: 0.8, fontSize: 36, bold: true });
  button(end, 'Start again', 1, 0.65, 6.65, 2.7);
  button(end, 'End show', endShow, 3.65, 6.65, 3);

  for (const { task, start, next } of feedback) {
    const correct = deck.addSlide();
    correct.addText('Correct!', { x: 0.65, y: 0.8, w: 12, h: 0.8, fontSize: 36, bold: true, color: '166447' });
    if (task.quiz.explanation) {
      correct.addText(task.quiz.explanation, {
        x: 0.65, y: 2, w: 12, h: 3.8, fontSize: 24, fit: 'shrink', valign: 'top',
      });
    }
    button(correct, 'Next →', next, 0.65, 6.65, 2.3);
    exitButton(correct, endSlide);

    const incorrect = deck.addSlide();
    incorrect.addText('Try again', { x: 0.65, y: 0.8, w: 12, h: 0.8, fontSize: 36, bold: true });
    button(incorrect, 'Back to the question', start, 0.65, 6.65, 2.3);
    exitButton(incorrect, endSlide);
  }

  return finalizeQuiz(deck, zipApi, endSlide, endSlide + feedback.length * 2);
}
