// SPDX-License-Identifier: AGPL-3.0-only

/** Resolve titles without replacing the initial static page's SEO title.
 * Other tools opened in the same document retain their own localized title.
 */
export function resolveToolPageTitle(toolTitle, toolKey, initialPage) {
  // The Arabic compression SEO experiment is frozen until owner review.
  const frozen = initialPage.lang === 'ar' && toolKey === 'compress';
  if (!frozen && toolKey === initialPage.toolKey && initialPage.title) {
    return initialPage.title;
  }
  return toolTitle + ' — PDFree';
}
