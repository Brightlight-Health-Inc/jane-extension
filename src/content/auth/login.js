/**
 * LOGIN MODULE
 *
 * Handles authentication with Jane App:
 * - Human-like typing to avoid bot detection
 * - Session validation
 * - Login state detection
 */

import { TIMEOUTS, SELECTORS } from '../../shared/constants.js';
import { sleep } from '../../shared/utils/async-utils.js';

/**
 * Custom error for login failures
 */
export class LoginError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'LoginError';
    this.cause = cause;
  }
}

/**
 * Check if user is already logged into Jane App
 *
 * @returns {Promise<boolean>} True if logged in
 */
export async function isAlreadyLoggedIn() {
  try {
    const isOnAdminPage = window.location.href.includes('/admin');
    const hasLoginForm = !!document.querySelector(SELECTORS.EMAIL_INPUT);

    return isOnAdminPage && !hasLoginForm;
  } catch (error) {
    console.error('Failed to check login status:', error);
    return false;
  }
}

/**
 * Check if login was successful
 * Called after login button click, page should have reloaded
 *
 * @returns {Promise<boolean>} True if login succeeded
 */
export async function isLoginSuccessful() {
  try {
    const isOnAdminPage = window.location.href.includes('/admin');
    const hasJaneAppShell = !!document.querySelector(SELECTORS.ADMIN_SHELL);

    return isOnAdminPage && hasJaneAppShell;
  } catch (error) {
    console.error('Failed to check login success:', error);
    return false;
  }
}

/**
 * Type text into an input field with human-like delays
 * Adds random delays between characters to avoid bot detection
 *
 * @param {HTMLInputElement} input - Input element to type into
 * @param {string} text - Text to type
 * @param {Object} options - Configuration
 * @param {Function} options.shouldStop - Function that returns true to stop typing
 * @param {Function} options.logger - Optional logger instance
 * @returns {Promise<void>}
 * @throws {Error} If shouldStop returns true
 */
export async function typeHumanLike(input, text, options = {}) {
  const {
    shouldStop = null,
    logger = null
  } = options;

  if (!input) {
    throw new Error('Input element is required');
  }

  if (!text || typeof text !== 'string') {
    throw new Error('Text must be a non-empty string');
  }

  try {
    // Focus on input
    input.focus();
    await sleep(TIMEOUTS.LOGIN_INPUT_DELAY, { shouldStop });

    // Type each character with random human-like delay
    for (const character of text) {
      // Check if we should stop
      if (shouldStop && shouldStop()) {
        throw new Error('Stopped while typing');
      }

      // Add character to input
      input.value += character;

      // Trigger input event (required for React/Angular apps)
      input.dispatchEvent(new Event('input', { bubbles: true }));

      // Random delay between characters (30-60ms)
      const delay = TIMEOUTS.TYPING_CHAR_MIN_DELAY +
                    Math.random() * (TIMEOUTS.TYPING_CHAR_MAX_DELAY - TIMEOUTS.TYPING_CHAR_MIN_DELAY);

      await sleep(delay, { shouldStop });
    }

    if (logger) {
      logger.debug(`Typed ${text.length} characters`);
    }
  } catch (error) {
    if (logger) {
      logger.error('Human-like typing failed', error);
    }
    throw error;
  }
}

/**
 * Wait for an element to appear with retry
 *
 * @param {string} selector - CSS selector
 * @param {Object} options - Configuration
 * @param {number} options.timeout - Max wait time in ms
 * @param {number} options.pollInterval - Check interval in ms
 * @param {Function} options.shouldStop - Stop check function
 * @returns {Promise<HTMLElement>} The found element
 * @throws {Error} If element not found or stopped
 */
async function waitForElement(selector, options = {}) {
  const {
    timeout = TIMEOUTS.MAX_WAIT_TIME,
    pollInterval = 500,
    shouldStop = null
  } = options;

  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (shouldStop && shouldStop()) {
      throw new Error('Stopped while waiting for element');
    }

    const element = document.querySelector(selector);
    if (element) {
      return element;
    }

    await sleep(pollInterval, { shouldStop });
  }

  throw new Error(`Timeout waiting for element: ${selector}`);
}

/**
 * Log into Jane App
 *
 * @param {string} email - User email
 * @param {string} password - User password
 * @param {Object} options - Configuration
 * @param {Function} options.shouldStop - Function that returns true to stop login
 * @param {Object} options.logger - Logger instance for status updates
 * @returns {Promise<Object>} Result object {success: boolean, alreadyLoggedIn?: boolean, willReload?: boolean}
 * @throws {LoginError} If login fails
 */
export async function login(email, password, options = {}) {
  const {
    shouldStop = null,
    logger = null
  } = options;

  try {
    // Wait for page to be ready
    if (document.readyState === 'loading') {
      await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve));
    }
    await sleep(TIMEOUTS.LOGIN_FORM_WAIT, { shouldStop });

    // Check if already logged in
    if (logger) {
      logger.info('Checking login status');
    }

    if (await isAlreadyLoggedIn()) {
      if (logger) {
        logger.success('Already logged in');
      }
      return { success: true, alreadyLoggedIn: true };
    }

    if (logger) {
      logger.info('Waiting for login page');
    }
    await sleep(TIMEOUTS.LOGIN_FORM_WAIT, { shouldStop });

    // Find email field
    if (logger) {
      logger.info('Finding email field');
    }

    const emailInput = await waitForElement(SELECTORS.EMAIL_INPUT, {
      timeout: 10000,
      shouldStop
    });

    if (!emailInput) {
      throw new LoginError('Email field not found');
    }

    // Type email
    if (logger) {
      logger.info('Typing email');
    }

    await typeHumanLike(emailInput, email, { shouldStop, logger });

    if (logger) {
      logger.success('Email entered');
    }
    await sleep(TIMEOUTS.POST_EMAIL_DELAY, { shouldStop });

    // Find password field
    const passwordInput = await waitForElement(SELECTORS.PASSWORD_INPUT, {
      timeout: 5000,
      shouldStop
    });

    if (!passwordInput) {
      throw new LoginError('Password field not found');
    }

    // Type password
    if (logger) {
      logger.info('Typing password');
    }

    await typeHumanLike(passwordInput, password, { shouldStop, logger });

    if (logger) {
      logger.success('Password entered');
    }
    await sleep(TIMEOUTS.POST_PASSWORD_DELAY, { shouldStop });

    // Find and click sign in button
    if (logger) {
      logger.info('Clicking Sign In button');
    }

    const signInButton = await waitForElement(SELECTORS.SIGN_IN_BUTTON, {
      timeout: 5000,
      shouldStop
    });

    if (!signInButton) {
      throw new LoginError('Sign In button not found');
    }

    signInButton.click();

    // Page will reload after successful login
    return { success: true, willReload: true };

  } catch (error) {
    if (error.message === 'Stopped' || error.message.includes('Stopped while')) {
      if (logger) {
        logger.warn('Login stopped by user');
      }
      throw error; // Re-throw stop errors
    }

    if (logger) {
      logger.error('Login failed', error);
    }

    // Wrap non-LoginError errors
    if (error instanceof LoginError) {
      throw error;
    } else {
      throw new LoginError(error.message, error);
    }
  }
}

/**
 * Handle post-login page (called after page reloads)
 *
 * @param {Object} options - Configuration
 * @param {Function} options.shouldStop - Stop check function
 * @param {Object} options.logger - Logger instance
 * @returns {Promise<boolean>} True if login was successful
 */
export async function handlePostLogin(options = {}) {
  const {
    shouldStop = null,
    logger = null
  } = options;

  try {
    // Wait for page to settle after reload
    await sleep(TIMEOUTS.PATIENT_PAGE_LOAD, { shouldStop });

    // Check if login succeeded
    const success = await isLoginSuccessful();

    if (success) {
      if (logger) {
        logger.success('Login successful');
      }
      return true;
    } else {
      if (logger) {
        logger.error('Login failed');
      }
      return false;
    }
  } catch (error) {
    if (logger) {
      logger.error('Post-login check failed', error);
    }
    return false;
  }
}
