import { expect, type Locator, type Page } from '@playwright/test'

// Caret placement and text selection in the notebook editor that the editor itself carries
// out, so a test does not depend on how the browser moves a native caret (#250).
//
// Found in CI (#250): with reference blocks on the page (contenteditable=false), Control+End
// sometimes moved the caret to the end of the page and sometimes left it where it was, and
// the editor sometimes did not take up a Shift+Home selection that the DOM briefly showed.
// A click and a triple click are handled by the editor (ProseMirror) as pointer selections.

const editorOf = (page: Page): Locator => page.getByRole('textbox', { name: 'Page text' })

/** Puts the caret at the end of the first paragraph's line: a click past its last word. */
export async function endOfFirstParagraph(page: Page): Promise<void> {
  const first = editorOf(page).locator('p').first()
  const box = await first.boundingBox()
  if (!box) throw new Error('The first paragraph is not visible.')
  await first.click({ position: { x: box.width - 2, y: box.height / 2 } })
}

/**
 * Selects the whole text of one paragraph the way a person can: a triple click, which the
 * editor turns into a selection of exactly that paragraph's text. Waits until the page
 * shows that selection.
 */
export async function selectLine(line: Locator): Promise<void> {
  const text = (await line.textContent()) ?? ''
  await line.click({ clickCount: 3 })
  await expect.poll(() => line.page().evaluate(() => window.getSelection()?.toString())).toBe(text)
}
