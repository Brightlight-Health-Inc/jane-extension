/**
 * POPUP SCRIPT
 * 
 * This script handles the extension's popup interface (shown when clicking the extension icon).
 * It provides a simple button to toggle the drawer/side panel on the current page.
 * 
 * Note: This appears to be legacy code. The extension now primarily uses chrome.action.onClicked
 * in background.js to open the side panel directly.
 */

/**
 * Initializes the popup when the DOM is loaded
 * 
 * Sets up a click handler for the "Open Drawer" button that sends a message
 * to the content script to toggle the drawer, then closes the popup.
 */
document.addEventListener('DOMContentLoaded', () => {
  const openDrawerBtn = document.getElementById('openDrawer');

  openDrawerBtn.addEventListener('click', async () => {
    // Send message to content script to toggle drawer
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    chrome.tabs.sendMessage(tab.id, { action: 'toggleDrawer' }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('Error:', chrome.runtime.lastError.message);
      } else {
        window.close(); // Close the popup
      }
    });
  });
});
