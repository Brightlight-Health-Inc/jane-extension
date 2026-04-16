/**
 * DOM UTILITIES
 *
 * Visibility helpers for Jane's SPA. Some loading indicators remain mounted in
 * the DOM after they are visually hidden, so callers should prefer these
 * helpers over raw querySelector existence checks.
 */

/**
 * Check whether an element is currently visible to the user.
 *
 * @param {Element|null} element - DOM element to inspect
 * @returns {boolean} True if element is visible
 */
export function isElementVisible(element) {
  if (!element || !element.isConnected) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.visibility === 'collapse' ||
    style.opacity === '0'
  ) {
    return false;
  }

  return element.getClientRects().length > 0;
}

/**
 * Get all visible elements matching a selector.
 *
 * @param {string} selector - CSS selector
 * @param {ParentNode} root - Root node to search from
 * @returns {Element[]} Visible matching elements
 */
export function getVisibleElements(selector, root = document) {
  try {
    return Array.from(root.querySelectorAll(selector)).filter(isElementVisible);
  } catch (error) {
    return [];
  }
}

/**
 * Check whether any visible element matches a selector.
 *
 * @param {string} selector - CSS selector
 * @param {ParentNode} root - Root node to search from
 * @returns {boolean} True if at least one visible match exists
 */
export function hasVisibleElement(selector, root = document) {
  return getVisibleElements(selector, root).length > 0;
}
