/**
 * @file Shared utility functions for the ASHP GUI.
 */

/**
 * Parses a UTC timestamp string from the server into a Date object.
 * SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" without timezone indicator.
 * JavaScript's new Date() interprets that as local time, causing timezone offset bugs.
 * Appending 'Z' forces UTC interpretation.
 *
 * @param {string} timestamp - Timestamp string from the server
 * @returns {Date} Date object in UTC
 */
export function parseUTC(timestamp) {
  if (!timestamp) return new Date(0);
  // Already has timezone indicator
  if (timestamp.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(timestamp)) {
    return new Date(timestamp);
  }
  // SQLite format "YYYY-MM-DD HH:MM:SS" → append Z for UTC
  return new Date(timestamp.replace(' ', 'T') + 'Z');
}
